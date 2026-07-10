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
import type { ClickUpTaskEvent, ClickUpWebhookSubscription, StoredTaskEvent } from './taskEventStore.js';

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

// Everything needed to explain WHY a delivery went the way it did. Attached
// to every IngestionResult so the transport layer can emit one structured
// log line per delivery, and PR3's debug tool can reason about the pattern.
//
// NEVER carries the shared_secret — only its length, so we can spot "stored
// undefined/empty" without leaking the secret. Same for the payload: prefix
// only, never the whole body (which is safe on its own but shouldn't hit
// disk unbounded).
export interface IngestionLogContext {
  branch: 'ok' | 'bad-json' | 'missing-webhook-id' | 'unknown-webhook' | 'bad-signature' | 'insert-failed';
  webhookId: string | null;
  subscriptionId: number | null;
  storedSecretLen: number | null;
  sigPresent: boolean;
  sigLen: number;
  bodyLen: number;
  bodyPrefix: string;
  insertedEventCount?: number;
  failCountBumped: boolean;
}

export interface IngestionResult {
  status: 200 | 400 | 401 | 404;
  body: { ok: true } | { error: string };
  insertedEventCount?: number;
  logContext: IngestionLogContext;
}

// Pure ingestion logic given the raw body bytes, the X-Signature header, and
// a store. Returns an IngestionResult the transport layer maps to an HTTP
// response.
//
// Contract:
//   200 → signature verified, insert succeeded (insertedEventCount reflects rows)
//   200 + fail_count bumped → signature verified, insert threw (rare — DB blip)
//   401 + fail_count bumped → signature failed. Bumping is the fix for PR3's
//         "silent 200" divergence: previously only insert failures bumped, so
//         a wrong-stored-secret produced ClickUp fail_count=30 vs local 0.
//   404 → webhook_id in body doesn't match any subscription. No fail_count
//         bump because we don't know which sub to charge; log has full context.
//   400 → bad JSON or missing webhook_id. Same rationale as 404.
export async function handleClickUpWebhookIngest(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  store: IngestionStore,
): Promise<IngestionResult> {
  const buf: Buffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const sig = signatureHeader || '';
  const bodyPrefix = buf.slice(0, 200).toString('utf8');

  const baseCtx: IngestionLogContext = {
    branch: 'ok',
    webhookId: null,
    subscriptionId: null,
    storedSecretLen: null,
    sigPresent: !!signatureHeader,
    sigLen: sig.length,
    bodyLen: buf.length,
    bodyPrefix,
    failCountBumped: false,
  };

  let parsed: any;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { error: 'Invalid JSON body' },
      logContext: { ...baseCtx, branch: 'bad-json' },
    };
  }

  const webhookId = parsed?.webhook_id ? String(parsed.webhook_id) : '';
  if (!webhookId) {
    return {
      status: 400,
      body: { error: 'Missing webhook_id in body' },
      logContext: { ...baseCtx, branch: 'missing-webhook-id' },
    };
  }
  baseCtx.webhookId = webhookId;

  const sub = await store.getSubscriptionByWebhookId(webhookId);
  if (!sub) {
    return {
      status: 404,
      body: { error: 'Unknown webhook' },
      logContext: { ...baseCtx, branch: 'unknown-webhook' },
    };
  }
  baseCtx.subscriptionId = sub.id;
  baseCtx.storedSecretLen = sub.sharedSecret ? sub.sharedSecret.length : 0;

  if (!verifyClickUpSignature(sub.sharedSecret, buf, sig)) {
    // Bump local fail_count so it tracks ClickUp's. This is the specific fix
    // for the divergence PR3's debug tool caught: ClickUp fail_count=30, ours=0.
    let failCountBumped = false;
    try {
      await store.incrementFailCount(sub.id);
      failCountBumped = true;
    } catch (err: any) {
      console.error(`[clickup-ingest] incrementFailCount failed for subscription ${sub.id}:`, err?.message || err);
    }
    return {
      status: 401,
      body: { error: 'Invalid signature' },
      logContext: { ...baseCtx, branch: 'bad-signature', failCountBumped },
    };
  }

  let insertedEventCount: number;
  try {
    const events = parseClickUpWebhookPayload(parsed, { id: sub.id, workspaceId: sub.workspaceId });
    insertedEventCount = await store.insertTaskEvents(events);
  } catch (err: any) {
    console.error(`[clickup-ingest] insert failure for subscription ${sub.id}:`, err?.message || err);
    let failCountBumped = false;
    try { await store.incrementFailCount(sub.id); failCountBumped = true; } catch { /* best-effort */ }
    // Still 200 so ClickUp doesn't disable the webhook for our own DB blip —
    // insert failures are treated as transient. Signature failures (above)
    // are treated as permanent + reported as 401 so ClickUp counts them too.
    return {
      status: 200,
      body: { ok: true },
      insertedEventCount: 0,
      logContext: { ...baseCtx, branch: 'insert-failed', insertedEventCount: 0, failCountBumped },
    };
  }

  return {
    status: 200,
    body: { ok: true },
    insertedEventCount,
    logContext: { ...baseCtx, branch: 'ok', insertedEventCount },
  };
}

// -----------------------------------------------------------------------------
// Subscribe flow helpers
// -----------------------------------------------------------------------------

const SECRET_KEYS = new Set(['secret', 'shared_secret', 'sharedSecret', 'token', 'access_token']);

// Recursively replace known-sensitive fields with [REDACTED]. Used before
// stringifying a ClickUp webhook-create response into an error message, so
// a malformed response can't leak the shared_secret we're about to store.
export function redactWebhookSecrets<T = any>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return (value as any[]).map(redactWebhookSecrets) as any;
  if (typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    out[k] = SECRET_KEYS.has(k) ? '[REDACTED]' : redactWebhookSecrets(v);
  }
  return out as T;
}

// Extracts (webhookId, sharedSecret) from the varied response shapes ClickUp
// returns from POST /team/{id}/webhook. Returns a tagged result so the caller
// can either use the credentials or emit a REDACTED-shape error — never a raw
// stringified response.
export function extractWebhookCreds(
  created: any,
): { ok: true; webhookId: string; sharedSecret: string } | { ok: false; error: string } {
  const webhookId = created?.id || created?.webhook?.id;
  const sharedSecret = created?.webhook?.secret || created?.secret;
  if (!webhookId || !sharedSecret) {
    const safe = JSON.stringify(redactWebhookSecrets(created)).slice(0, 500);
    return {
      ok: false,
      error: `ClickUp webhook creation returned no id/secret. Redacted response: ${safe}`,
    };
  }
  return { ok: true, webhookId: String(webhookId), sharedSecret: String(sharedSecret) };
}

// Dependencies the subscribe orchestrator needs. Splits ClickUp client calls
// from the persistence store so tests can wire fakes for each side and
// exercise the orphan-cleanup path.
export interface SubscribeDeps {
  createWebhook(workspaceId: string, params: { endpoint: string; events: string[] }): Promise<any>;
  deleteWebhook(webhookId: string): Promise<any>;
  findSubscription(userId: number, workspaceId: string): Promise<ClickUpWebhookSubscription | null>;
  createSubscription(input: {
    userId: number;
    workspaceId: string;
    clickupWebhookId: string;
    sharedSecret: string;
    events: string[];
  }): Promise<ClickUpWebhookSubscription>;
}

export interface SubscribeFlowResult {
  kind: 'existing' | 'created';
  subscription: ClickUpWebhookSubscription;
}

// Orchestrates: check idempotency → create webhook on ClickUp → validate
// response → persist subscription → on persist failure, roll the ClickUp
// webhook back so a retry doesn't accumulate orphans.
//
// Throws plain Error; the MCP tool re-wraps as UserError. That keeps the
// helper free of fastmcp coupling for test purposes.
export async function subscribeToTaskEventsFlow(
  deps: SubscribeDeps,
  input: { userId: number; workspaceId: string; events: string[]; endpoint: string },
): Promise<SubscribeFlowResult> {
  // 1. Idempotency: never hit ClickUp if we already own a subscription for
  //    this (user, workspace). Return the existing record as-is.
  const existing = await deps.findSubscription(input.userId, input.workspaceId);
  if (existing) return { kind: 'existing', subscription: existing };

  // 2. Create webhook on ClickUp.
  let created: any;
  try {
    created = await deps.createWebhook(input.workspaceId, {
      endpoint: input.endpoint,
      events: input.events,
    });
  } catch (err: any) {
    throw new Error(`Failed to create ClickUp webhook: ${err?.message || err}`);
  }

  // 3. Extract creds. Response shape varies; extractor also redacts secrets
  //    from any error message it emits.
  const creds = extractWebhookCreds(created);
  if (!creds.ok) throw new Error(creds.error);

  // 4. Persist. If this throws, we've created a webhook on ClickUp but have
  //    no record of it — delete it before rethrowing so a retry doesn't
  //    accumulate duplicate ghost webhooks and blow past ClickUp's per-team
  //    webhook cap.
  try {
    const sub = await deps.createSubscription({
      userId: input.userId,
      workspaceId: input.workspaceId,
      clickupWebhookId: creds.webhookId,
      sharedSecret: creds.sharedSecret,
      events: input.events,
    });
    return { kind: 'created', subscription: sub };
  } catch (persistErr: any) {
    let cleanupNote = 'rolled back';
    try {
      await deps.deleteWebhook(creds.webhookId);
    } catch (cleanupErr: any) {
      // Log-and-continue: the original persist error is what matters most,
      // but the operator needs to know the ClickUp webhook is still live so
      // they can delete it manually.
      console.error(
        `[clickup-subscribe] cleanup failed for orphaned webhook ${creds.webhookId}:`,
        cleanupErr?.message || cleanupErr,
      );
      cleanupNote = `cleanup FAILED — orphaned ClickUp webhook ${creds.webhookId} must be deleted manually`;
    }
    const msg = persistErr?.message || String(persistErr);
    throw new Error(`Failed to persist ClickUp subscription (webhook ${cleanupNote}): ${msg}`);
  }
}

// -----------------------------------------------------------------------------
// Query flow — read side of the event store
// -----------------------------------------------------------------------------

// A read result the query tool renders to Claude/ChatGPT. Always carries the
// eventStoreStartedAt boundary so callers know the pre-subscribe cutoff: if
// their `since` predates the subscription, the empty result is not "nothing
// changed" but "we weren't listening yet — fall back to filterTeamTasks'
// date_updated_gt for that window."
export interface QueryTaskEventsResult {
  kind: 'ok' | 'no-subscription';
  subscription?: ClickUpWebhookSubscription;
  events: StoredTaskEvent[];
  eventStoreStartedAt?: string;
  warning?: string;
}

export interface QueryDeps {
  findSubscription(userId: number, workspaceId: string): Promise<ClickUpWebhookSubscription | null>;
  queryTaskEvents(input: {
    subscriptionId: number;
    since?: number;
    until?: number;
    eventTypes?: string[];
    toStatus?: string;
    taskId?: string;
    limit?: number;
  }): Promise<StoredTaskEvent[]>;
}

// Runs a workspace-scoped event query with lazy self-heal:
//   - No subscription for (user, workspace) → kind='no-subscription' with a
//     warning telling the caller to /subscribe first. Not an error: the
//     digest can still fall back to pull.
//   - Subscription exists but `since` predates its createdAt → still runs
//     the query, but attaches a warning explaining the missing window.
//   - Otherwise → kind='ok' with events sorted newest-first.
export async function queryTaskEventsFlow(
  deps: QueryDeps,
  input: {
    userId: number;
    workspaceId: string;
    since?: number;
    until?: number;
    eventTypes?: string[];
    toStatus?: string;
    taskId?: string;
    limit?: number;
  },
): Promise<QueryTaskEventsResult> {
  const sub = await deps.findSubscription(input.userId, input.workspaceId);
  if (!sub) {
    return {
      kind: 'no-subscription',
      events: [],
      warning:
        `No task-event subscription exists for workspace ${input.workspaceId}. ` +
        `Call subscribeToTaskEvents first — history accrues from that moment forward. ` +
        `For events before that boundary, fall back to filterTeamTasks with dateUpdatedGt.`,
    };
  }

  const events = await deps.queryTaskEvents({
    subscriptionId: sub.id,
    since: input.since,
    until: input.until,
    eventTypes: input.eventTypes,
    toStatus: input.toStatus,
    taskId: input.taskId,
    limit: input.limit,
  });

  let warning: string | undefined;
  if (input.since !== undefined) {
    const subStartMs = Date.parse(sub.createdAt);
    if (Number.isFinite(subStartMs) && input.since < subStartMs) {
      warning =
        `Query 'since' predates subscription creation (${sub.createdAt}). ` +
        `Events before that timestamp are not in the store — for that earlier window, ` +
        `fall back to filterTeamTasks with dateUpdatedGt.`;
    }
  }

  return {
    kind: 'ok',
    subscription: sub,
    events,
    eventStoreStartedAt: sub.createdAt,
    warning,
  };
}

// -----------------------------------------------------------------------------
// Debug flow — cross-reference local DB vs ClickUp's own view vs event store
// -----------------------------------------------------------------------------

// Report a debug caller sees. Optional fields let the same shape represent
// every failure mode (no local record, no ClickUp record, both present but
// disagreeing on endpoint/events/health).
export interface DebugReport {
  kind: 'ok' | 'no-local-subscription' | 'no-clickup-webhook';
  workspaceId: string;
  expectedEndpoint: string;
  local?: {
    id: number;
    clickupWebhookId: string;
    events: string[];
    status: string;
    failCount: number;
    createdAt: string;
  };
  clickup?: {
    id: string;
    endpoint: string;
    events: string[];
    healthStatus: string | null;
    healthFailCount: number | null;
    rawHealth?: any;
  };
  eventStore?: {
    count: number;
    mostRecentOccurredAt: number | null;
    mostRecentReceivedAt: string | null;
  };
  // Human-readable anomalies + suggested next actions. Order matters — the
  // caller renders these in a single "Findings" block.
  findings: string[];
}

export interface DebugDeps {
  findSubscription(userId: number, workspaceId: string): Promise<ClickUpWebhookSubscription | null>;
  listWebhooks(workspaceId: string): Promise<any>;
  countTaskEventsForSubscription(subscriptionId: number): Promise<number>;
  queryTaskEvents(input: { subscriptionId: number; limit?: number }): Promise<StoredTaskEvent[]>;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const A = new Set(a);
  for (const x of b) if (!A.has(x)) return false;
  return true;
}

export async function debugTaskEventSubscriptionFlow(
  deps: DebugDeps,
  input: { userId: number; workspaceId: string; expectedEndpoint: string },
): Promise<DebugReport> {
  const findings: string[] = [];
  const report: DebugReport = {
    kind: 'ok',
    workspaceId: input.workspaceId,
    expectedEndpoint: input.expectedEndpoint,
    findings,
  };

  const localSub = await deps.findSubscription(input.userId, input.workspaceId);
  if (localSub) {
    report.local = {
      id: localSub.id,
      clickupWebhookId: localSub.clickupWebhookId,
      events: localSub.events,
      status: localSub.status,
      failCount: localSub.failCount,
      createdAt: localSub.createdAt,
    };
  } else {
    report.kind = 'no-local-subscription';
    findings.push(
      'No local subscription record for this (user, workspace). Call subscribeToTaskEvents first, or check that the caller has been logged in as the same user who subscribed.',
    );
  }

  // Pull ClickUp's view even when local is missing — a stale webhook on
  // ClickUp's side (created by a previous account, or one whose local record
  // got cleaned up) is exactly the kind of orphan a debug tool should catch.
  let clickupWebhooks: any[] = [];
  try {
    const raw = await deps.listWebhooks(input.workspaceId);
    clickupWebhooks = Array.isArray(raw?.webhooks) ? raw.webhooks : [];
  } catch (err: any) {
    findings.push(`Failed to fetch ClickUp's webhook list: ${err?.message || err}. Skipping ClickUp-side checks.`);
  }

  // Match by webhook id if we have a local record, else by endpoint URL.
  let match: any = undefined;
  if (localSub) {
    match = clickupWebhooks.find(w => String(w?.id) === localSub.clickupWebhookId);
  }
  if (!match && input.expectedEndpoint) {
    match = clickupWebhooks.find(w => String(w?.endpoint) === input.expectedEndpoint);
  }

  if (match) {
    report.clickup = {
      id: String(match.id),
      endpoint: String(match.endpoint || ''),
      events: Array.isArray(match.events) ? match.events.map(String) : [],
      healthStatus: match.health?.status ? String(match.health.status) : null,
      healthFailCount: typeof match.health?.fail_count === 'number' ? match.health.fail_count : null,
      rawHealth: match.health,
    };
  } else if (localSub) {
    report.kind = 'no-clickup-webhook';
    findings.push(
      `Local record points at ClickUp webhook ${localSub.clickupWebhookId} but ClickUp has no such webhook in this workspace. It was likely deleted on ClickUp's side. Recreate: delete the local record and call subscribeToTaskEvents again.`,
    );
  }

  // Endpoint mismatch (URL rot) — highest-priority root cause per the design
  // note. Very common when BASE_URL changes between subscribe and deploy.
  if (report.clickup && report.clickup.endpoint !== input.expectedEndpoint) {
    findings.push(
      `Endpoint mismatch: ClickUp is delivering to "${report.clickup.endpoint}" but the current BASE_URL would produce "${input.expectedEndpoint}". This is the most common cause of "fail_count stays 0 and nothing lands." Fix: delete the ClickUp webhook (via unsubscribe or ClickUp UI) and re-run subscribeToTaskEvents so a fresh webhook is created against the current URL.`,
    );
  }

  // Events mismatch — someone edited the webhook on ClickUp's side, or PR1
  // shipped a different default bundle than what's currently stored.
  if (report.clickup && localSub && !sameStringSet(report.clickup.events, localSub.events)) {
    findings.push(
      `Event bundle differs: ClickUp is subscribed to [${report.clickup.events.join(', ')}] but the local record says [${localSub.events.join(', ')}]. One side has been edited out of band.`,
    );
  }

  // fail_count divergence — ClickUp says delivery is failing but our counter
  // hasn't moved. Classic sign the outer try/catch in ingestion is swallowing.
  if (report.clickup && localSub) {
    const cf = report.clickup.healthFailCount;
    if (cf !== null && cf > localSub.failCount) {
      findings.push(
        `ClickUp fail_count (${cf}) exceeds local fail_count (${localSub.failCount}). Deliveries are failing on ClickUp's side but our subscription record isn't being updated. Most likely: the ingestion route's outer catch is returning 200 on a thrown error before it reaches store.incrementFailCount, so ClickUp keeps retrying and we don't notice.`,
      );
    }
    if (report.clickup.healthStatus && report.clickup.healthStatus !== 'active') {
      findings.push(
        `ClickUp reports webhook health.status="${report.clickup.healthStatus}". Webhook has been disabled by ClickUp (typically after 5 consecutive delivery failures). Delete + re-subscribe to restore.`,
      );
    }
  }

  // Event-store counts + last-event timestamps. Only meaningful when there's
  // a local subscription — the count is scoped to that subscription's rows.
  if (localSub) {
    let count = 0;
    try { count = await deps.countTaskEventsForSubscription(localSub.id); }
    catch (err: any) { findings.push(`Failed to count events: ${err?.message || err}`); }

    let mostRecent: StoredTaskEvent | undefined;
    try {
      const recent = await deps.queryTaskEvents({ subscriptionId: localSub.id, limit: 1 });
      mostRecent = recent[0];
    } catch (err: any) {
      findings.push(`Failed to fetch most recent event: ${err?.message || err}`);
    }

    report.eventStore = {
      count,
      mostRecentOccurredAt: mostRecent?.occurredAt ?? null,
      mostRecentReceivedAt: mostRecent?.receivedAt ?? null,
    };

    // Zero-events call-out. Only fires when nothing has landed AND ClickUp
    // reports no delivery failures — that's the specific pattern (silent 200s
    // from ingestion) the debug tool exists to surface.
    if (count === 0 && report.clickup && (report.clickup.healthFailCount === 0 || report.clickup.healthFailCount === null)) {
      const created = Date.parse(localSub.createdAt);
      const ageMinutes = Number.isFinite(created) ? Math.round((Date.now() - created) / 60000) : NaN;
      findings.push(
        `Zero events stored, and ClickUp reports zero delivery failures. If the subscription is more than a few minutes old (age: ${Number.isFinite(ageMinutes) ? ageMinutes + 'm' : 'unknown'}) and you know ClickUp has fired events (task moves, new tasks) in that window, deliveries are either not reaching the ingestion route at all OR the route is returning 200 without persisting. Check dev logs for "[clickup-ingest]" entries.`,
      );
    }
  }

  if (findings.length === 0) {
    findings.push('No anomalies detected. Local record, ClickUp record, and event store are consistent.');
  }
  return report;
}

