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
