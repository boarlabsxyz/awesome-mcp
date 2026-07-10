// src/clickup/taskEventStore.ts
//
// Persistence layer for ClickUp webhook subscriptions and the task event
// stream they produce. Postgres-only — file fallback would grow unbounded
// and JSON gets messy fast, and this feature only makes sense once you have
// real infra.
//
// Public API:
//   findSubscription(userId, workspaceId)  — for idempotent subscribeToTaskEvents
//   getSubscriptionByWebhookId(webhookId)  — for HMAC verification at ingestion
//   createSubscription(...)                — after ClickUp returns webhook_id + secret
//   incrementFailCount(subscriptionId)     — bookkeeping when we can't process an event
//   insertTaskEvents(events[])             — batch insert during ingestion
//   listSubscriptionsForUser(userId, ...)  — read side of "which webhooks do I own"
//   queryTaskEvents(...)                   — read side of the digest (PR2 query tool)
//   countTaskEventsForSubscription(id)     — for the debug tool (PR3)
//   deleteSubscription(userId, workspaceId) — for unsubscribeFromTaskEvents (PR4)
//   pruneOldTaskEvents(retentionDays)      — nightly cleanup

import { isDatabaseAvailable, getPool } from '../db.js';

export interface ClickUpWebhookSubscription {
  id: number;
  userId: number;
  workspaceId: string;
  clickupWebhookId: string;
  sharedSecret: string;
  events: string[];
  status: 'active' | 'failed' | 'paused';
  failCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClickUpTaskEvent {
  subscriptionId: number;
  workspaceId: string;
  taskId: string;
  eventType: string;
  field: string | null;
  fromVal: string | null;
  toVal: string | null;
  actorId: string | null;
  actorUsername: string | null;
  occurredAt: number;
  rawPayload: any;
}

function requireDb(): void {
  if (!isDatabaseAvailable()) {
    throw new Error('ClickUp task events require Postgres. Set DATABASE_URL and REDIS_URL.');
  }
}

function mapSubscriptionRow(row: any): ClickUpWebhookSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    clickupWebhookId: row.clickup_webhook_id,
    sharedSecret: row.shared_secret,
    events: Array.isArray(row.events) ? row.events : JSON.parse(row.events || '[]'),
    status: row.status,
    failCount: row.fail_count,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export async function findSubscription(
  userId: number,
  workspaceId: string,
): Promise<ClickUpWebhookSubscription | null> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT id, user_id, workspace_id, clickup_webhook_id, shared_secret, events, status, fail_count, created_at, updated_at
     FROM clickup_webhook_subscriptions
     WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  if (rows.length === 0) return null;
  return mapSubscriptionRow(rows[0]);
}

export async function getSubscriptionByWebhookId(
  clickupWebhookId: string,
): Promise<ClickUpWebhookSubscription | null> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT id, user_id, workspace_id, clickup_webhook_id, shared_secret, events, status, fail_count, created_at, updated_at
     FROM clickup_webhook_subscriptions
     WHERE clickup_webhook_id = $1`,
    [clickupWebhookId],
  );
  if (rows.length === 0) return null;
  return mapSubscriptionRow(rows[0]);
}

export async function createSubscription(input: {
  userId: number;
  workspaceId: string;
  clickupWebhookId: string;
  sharedSecret: string;
  events: string[];
}): Promise<ClickUpWebhookSubscription> {
  requireDb();
  const { rows } = await getPool().query(
    `INSERT INTO clickup_webhook_subscriptions
       (user_id, workspace_id, clickup_webhook_id, shared_secret, events, status, fail_count)
     VALUES ($1, $2, $3, $4, $5, 'active', 0)
     RETURNING id, user_id, workspace_id, clickup_webhook_id, shared_secret, events, status, fail_count, created_at, updated_at`,
    [input.userId, input.workspaceId, input.clickupWebhookId, input.sharedSecret, JSON.stringify(input.events)],
  );
  return mapSubscriptionRow(rows[0]);
}

export async function incrementFailCount(subscriptionId: number): Promise<void> {
  requireDb();
  await getPool().query(
    `UPDATE clickup_webhook_subscriptions
     SET fail_count = fail_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId],
  );
}

// Batch insert. All events in a single POST from ClickUp share the same
// subscription so a single INSERT ... VALUES round-trip is enough.
export async function insertTaskEvents(events: ClickUpTaskEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  requireDb();
  const values: any[] = [];
  const placeholders: string[] = [];
  events.forEach((e, i) => {
    const b = i * 11;
    placeholders.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11})`);
    values.push(
      e.subscriptionId,
      e.workspaceId,
      e.taskId,
      e.eventType,
      e.field,
      e.fromVal,
      e.toVal,
      e.actorId,
      e.actorUsername,
      e.occurredAt,
      JSON.stringify(e.rawPayload),
    );
  });
  const { rowCount } = await getPool().query(
    `INSERT INTO clickup_task_events
       (subscription_id, workspace_id, task_id, event_type, field, from_val, to_val, actor_id, actor_username, occurred_at, raw_payload)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
  return rowCount || 0;
}

// A row returned from the events table, joined onto its owning subscription
// so callers can render "who owns this history" without a second lookup.
export interface StoredTaskEvent {
  id: number;
  subscriptionId: number;
  workspaceId: string;
  taskId: string;
  eventType: string;
  field: string | null;
  fromVal: string | null;
  toVal: string | null;
  actorId: string | null;
  actorUsername: string | null;
  occurredAt: number;
  receivedAt: string;
  rawPayload: any;
}

function mapEventRow(row: any): StoredTaskEvent {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    eventType: row.event_type,
    field: row.field,
    fromVal: row.from_val,
    toVal: row.to_val,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    occurredAt: typeof row.occurred_at === 'string' ? parseInt(row.occurred_at, 10) : Number(row.occurred_at),
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    rawPayload: row.raw_payload,
  };
}

// List every subscription owned by a user. Optional workspaceId narrows to
// a single record. Used by listTaskEventSubscriptions to surface fail_count
// so operators can spot a dying webhook.
export async function listSubscriptionsForUser(
  userId: number,
  workspaceId?: string,
): Promise<ClickUpWebhookSubscription[]> {
  requireDb();
  const params: any[] = [userId];
  let where = 'user_id = $1';
  if (workspaceId) { params.push(workspaceId); where += ` AND workspace_id = $${params.length}`; }
  const { rows } = await getPool().query(
    `SELECT id, user_id, workspace_id, clickup_webhook_id, shared_secret, events, status, fail_count, created_at, updated_at
     FROM clickup_webhook_subscriptions
     WHERE ${where}
     ORDER BY created_at DESC`,
    params,
  );
  return rows.map(mapSubscriptionRow);
}

// Query task events with all the filters the digest routine actually uses.
// Scoping is always by workspace (a subscription is workspace-wide from
// ClickUp's side — see per-(user, workspace) design note in PR1). Scoping by
// subscription is applied on top so caller B never sees events from a
// subscription owned by caller A even though they both share the workspace.
export async function queryTaskEvents(input: {
  subscriptionId: number;
  since?: number;
  until?: number;
  eventTypes?: string[];
  toStatus?: string;
  taskId?: string;
  limit?: number;
}): Promise<StoredTaskEvent[]> {
  requireDb();
  const params: any[] = [input.subscriptionId];
  const clauses: string[] = ['subscription_id = $1'];

  if (input.since !== undefined) { params.push(input.since); clauses.push(`occurred_at >= $${params.length}`); }
  if (input.until !== undefined) { params.push(input.until); clauses.push(`occurred_at <= $${params.length}`); }
  if (input.taskId) { params.push(input.taskId); clauses.push(`task_id = $${params.length}`); }
  if (input.eventTypes && input.eventTypes.length > 0) {
    params.push(input.eventTypes);
    clauses.push(`event_type = ANY($${params.length}::text[])`);
  }
  if (input.toStatus) {
    // to_val for status transitions is the status label (see
    // stringifyChange in webhookHelpers.ts). Exact match.
    params.push(input.toStatus);
    clauses.push(`to_val = $${params.length}`);
  }

  // Hard cap on rows returned. Postgres can happily paginate but the MCP
  // caller (Claude/ChatGPT) is going to render this into a chat; a 100k-row
  // dump helps nobody. Callers narrow by `since` if they hit the cap.
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
  params.push(limit);

  const { rows } = await getPool().query(
    `SELECT id, subscription_id, workspace_id, task_id, event_type, field, from_val, to_val, actor_id, actor_username, occurred_at, received_at, raw_payload
     FROM clickup_task_events
     WHERE ${clauses.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapEventRow);
}

// Idempotent delete keyed by (user, workspace). Returns true when a row was
// removed. Used by the unsubscribe flow after client.deleteWebhook so a
// stuck subscription can be blown away and re-created cleanly.
export async function deleteSubscription(userId: number, workspaceId: string): Promise<boolean> {
  requireDb();
  const { rowCount } = await getPool().query(
    `DELETE FROM clickup_webhook_subscriptions WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return (rowCount || 0) > 0;
}

// Debug helper: how many events have we recorded for this subscription?
// Used by debugTaskEventSubscription to disambiguate "delivery never
// happened" from "delivery happened but nothing persisted."
export async function countTaskEventsForSubscription(subscriptionId: number): Promise<number> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM clickup_task_events WHERE subscription_id = $1`,
    [subscriptionId],
  );
  return rows[0]?.c ?? 0;
}

// Delete rows older than `retentionDays`. Cheap because of the
// (workspace_id, task_id, occurred_at DESC) index — the range scan is
// bounded by the sweep frequency. Returns the number of rows deleted so
// the scheduler can log a heartbeat.
export async function pruneOldTaskEvents(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  requireDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const { rowCount } = await getPool().query(
    `DELETE FROM clickup_task_events WHERE occurred_at < $1`,
    [cutoff],
  );
  return rowCount || 0;
}

let retentionTimer: NodeJS.Timeout | null = null;

// Read config once at scheduler start. Env: CLICKUP_EVENT_RETENTION_DAYS
// (default 90), CLICKUP_EVENT_PRUNE_INTERVAL_MS (default 6h). Sub-hour
// intervals get clamped up to 1h — the whole point is stateless overnight
// cleanup, not a real-time job.
function readRetentionConfig(): { retentionDays: number; intervalMs: number } {
  const retentionDays = Math.max(1, parseInt(process.env.CLICKUP_EVENT_RETENTION_DAYS || '90', 10) || 90);
  const rawInterval = parseInt(process.env.CLICKUP_EVENT_PRUNE_INTERVAL_MS || '', 10);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 3_600_000
    ? rawInterval
    : 6 * 60 * 60 * 1000;
  return { retentionDays, intervalMs };
}

// Start the nightly-ish prune loop. Safe to call multiple times — the second
// call is a no-op. Timer is .unref()'d so it doesn't block process exit
// (matters for tests and clean shutdown).
export function startTaskEventRetentionScheduler(): void {
  if (retentionTimer) return;
  if (!isDatabaseAvailable()) return;
  const { retentionDays, intervalMs } = readRetentionConfig();

  const runOnce = async () => {
    try {
      const deleted = await pruneOldTaskEvents(retentionDays);
      if (deleted > 0) {
        console.error(`[clickup-events] pruned ${deleted} rows older than ${retentionDays}d`);
      }
    } catch (err: any) {
      console.error('[clickup-events] prune failure:', err?.message || err);
    }
  };

  retentionTimer = setInterval(runOnce, intervalMs);
  retentionTimer.unref();
  // Kick off an initial sweep so a container that boots after a long outage
  // doesn't have to wait a full interval for the first cleanup.
  void runOnce();
}

export function stopTaskEventRetentionScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
