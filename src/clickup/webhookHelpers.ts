// src/clickup/webhookHelpers.ts
//
// Stateless helpers for the ClickUp webhook ingestion path:
//   - HMAC-SHA256 signature verification against the per-webhook shared
//     secret ClickUp returns when the webhook is created.
//   - Payload parser that flattens a single POST into 1..N task-event rows
//     (a single webhook fire can carry multiple history_items, e.g. moving
//     a task also emits a status change).
//
// Kept as pure functions so the ingestion route and the tests can share
// exactly the same logic.

import crypto from 'crypto';
import type { ClickUpTaskEvent, ClickUpWebhookSubscription } from './taskEventStore.js';

// The events we deliberately capture (see PR discussion — deliberately
// excludes taskUpdated, which is a firehose fully redundant with pull's
// date_updated_gt filter).
export const CAPTURED_EVENTS = [
  'taskCreated',
  'taskStatusUpdated',
  'taskAssigneeUpdated',
  'taskMoved',
  'taskDeleted',
] as const;
export type CapturedEvent = typeof CAPTURED_EVENTS[number];

// ClickUp signs webhook POSTs with HMAC-SHA256 over the raw request body,
// keyed by the per-webhook shared_secret returned at create time. The
// signature is hex-encoded in the X-Signature header. Constant-time compare
// so we don't leak timing info about how far the signature matched.
export function verifyClickUpSignature(secret: string, rawBody: string | Buffer, signature: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// Serialize a ClickUp history_item's before/after payload for from_val /
// to_val. For status transitions the caller usually only wants a label; for
// assignee changes it's a user id, etc. We stringify anything non-primitive
// so the query side can inspect it without a JSON parse in the hot path.
function stringifyChange(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && 'status' in (v as any) && typeof (v as any).status === 'string') {
    return (v as any).status;
  }
  if (typeof v === 'object' && 'username' in (v as any) && typeof (v as any).username === 'string') {
    return (v as any).username;
  }
  return JSON.stringify(v);
}

// Flattens a single ClickUp webhook POST body into task-event rows.
//
// Shape (from ClickUp docs):
//   { event, task_id, webhook_id, history_items: [ { field, before, after, date, user, ... }, ... ] }
//
// For taskCreated / taskDeleted the payload may not carry history_items;
// we still emit one row so the query side sees the event, with field/from/to
// left null and the full body preserved in raw_payload.
export function parseClickUpWebhookPayload(
  body: any,
  subscription: { id: number; workspaceId: string },
): ClickUpTaskEvent[] {
  const eventType = String(body?.event || 'unknown');
  const taskId = String(body?.task_id || body?.id || '');
  const rows: ClickUpTaskEvent[] = [];

  const items = Array.isArray(body?.history_items) ? body.history_items : [];

  if (items.length === 0) {
    rows.push({
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      taskId,
      eventType,
      field: null,
      fromVal: null,
      toVal: null,
      actorId: null,
      actorUsername: null,
      occurredAt: Date.now(),
      rawPayload: body ?? {},
    });
    return rows;
  }

  for (const item of items) {
    const occurredRaw = item?.date;
    let occurredAt = Number.NaN;
    if (typeof occurredRaw === 'number') occurredAt = occurredRaw;
    else if (typeof occurredRaw === 'string') occurredAt = parseInt(occurredRaw, 10);
    if (!Number.isFinite(occurredAt)) occurredAt = Date.now();

    rows.push({
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      taskId,
      eventType,
      field: item?.field ? String(item.field) : null,
      fromVal: stringifyChange(item?.before),
      toVal: stringifyChange(item?.after),
      actorId: item?.user?.id !== undefined ? String(item.user.id) : null,
      actorUsername: item?.user?.username ? String(item.user.username) : null,
      occurredAt,
      rawPayload: item,
    });
  }

  return rows;
}

// Store interface the ingestion handler needs. Extracted so tests can inject
// an in-memory fake without touching Postgres. The real implementations live
// in taskEventStore.ts; the ingestion path only reads what it uses here.
export interface IngestionStore {
  getSubscriptionByWebhookId(webhookId: string): Promise<ClickUpWebhookSubscription | null>;
  insertTaskEvents(events: ClickUpTaskEvent[]): Promise<number>;
  incrementFailCount(subscriptionId: number): Promise<void>;
}

export interface IngestionResult {
  status: 200 | 400 | 401 | 404;
  body: { ok: true } | { error: string };
  insertedEventCount?: number;
}

// Pure ingestion logic given the raw body bytes, the X-Signature header, and
// a store. Returns an IngestionResult the transport layer maps to an HTTP
// response. Contract: 200 iff signature verified AND at least one event row
// was inserted (or would have been — parse errors during insert still 200
// so ClickUp doesn't disable the webhook for our bug; store bumps fail_count).
export async function handleClickUpWebhookIngest(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  store: IngestionStore,
): Promise<IngestionResult> {
  const buf: Buffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  let parsed: any;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body' } };
  }

  const webhookId = parsed?.webhook_id ? String(parsed.webhook_id) : '';
  if (!webhookId) {
    return { status: 400, body: { error: 'Missing webhook_id in body' } };
  }

  const sub = await store.getSubscriptionByWebhookId(webhookId);
  if (!sub) {
    // Unknown webhook — could be a stale one ClickUp is retrying after we
    // deleted it, or a spoof. 404 so ClickUp stops sending. Don't leak
    // signature-check timing.
    return { status: 404, body: { error: 'Unknown webhook' } };
  }

  const sig = signatureHeader || '';
  if (!verifyClickUpSignature(sub.sharedSecret, buf, sig)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  let insertedEventCount = 0;
  try {
    const events = parseClickUpWebhookPayload(parsed, { id: sub.id, workspaceId: sub.workspaceId });
    insertedEventCount = await store.insertTaskEvents(events);
  } catch (err: any) {
    console.error(`[clickup-ingest] insert failure for subscription ${sub.id}:`, err?.message || err);
    try { await store.incrementFailCount(sub.id); } catch { /* best-effort */ }
    // Still 200 so ClickUp doesn't disable the webhook for our bug.
  }

  return { status: 200, body: { ok: true }, insertedEventCount };
}
