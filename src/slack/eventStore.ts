// src/slack/eventStore.ts
//
// Persistence layer for Slack channel-event subscriptions and the event stream
// they produce. Deliberately shaped like src/clickup/taskEventStore.ts — the
// tools, flows and tests all mirror that feature — but two things differ, and
// both come from Slack delivering events differently:
//
//   1. A subscription is a purely local interest filter. Slack event
//      subscriptions live on the app, not per user, so there is no remote id to
//      store and no per-subscription secret (verification uses the app-level
//      SLACK_SIGNING_SECRET).
//   2. Lookup at ingestion is by (team, channel) and returns MANY rows, because
//      one Request URL serves the whole workspace and N users can watch the
//      same channel. ClickUp got one webhook per subscriber, so its equivalent
//      returned one row.
//
// Postgres-only, same as the ClickUp store: a file fallback would grow
// unbounded and this feature only makes sense once you have real infra.
//
// Public API:
//   findSubscription(userId, teamId, channelId)   — for idempotent subscribe
//   findSubscriptionsForChannel(teamId, channelId) — fan-out target at ingestion
//   createSubscription(...)                      — insert the local filter row
//   incrementFailCount(subscriptionId)            — bookkeeping on a failed ingest
//   insertChannelEvents(events[])                 — batch insert, dedup by event_id
//   listSubscriptionsForUser(userId, channelId?)  — read side of "what am I watching"
//   querySlackEvents(...)                         — read side of getChannelEventHistory
//   countChannelEventsForSubscription(id)         — for the debug tool
//   deleteSubscription(userId, teamId, channelId) — for unsubscribe
//   pruneOldChannelEvents(retentionDays)          — periodic cleanup

import { isDatabaseAvailable, getPool } from '../db.js';

export interface SlackEventSubscription {
  id: number;
  userId: number;
  teamId: string;
  channelId: string;
  events: string[];
  /** Optional case-insensitive substring filter on the event's text. */
  matchPattern: string | null;
  status: 'active' | 'failed' | 'paused';
  failCount: number;
  createdAt: string;
  updatedAt: string;
}

/** An event as handed to insertChannelEvents. */
export interface SlackChannelEvent {
  subscriptionId: number;
  teamId: string;
  channelId: string;
  /** Slack's Ev… id — the dedup key for retried deliveries. */
  eventId: string;
  eventType: string;
  messageTs: string | null;
  threadTs: string | null;
  actorId: string | null;
  text: string | null;
  occurredAt: number;
  rawPayload: any;
}

/** A row read back out of the events table. */
export interface StoredSlackEvent extends SlackChannelEvent {
  id: number;
  receivedAt: string;
}

function requireDb(): void {
  if (!isDatabaseAvailable()) {
    throw new Error('Slack channel events require Postgres. Set DATABASE_URL and REDIS_URL.');
  }
}

function mapSubscriptionRow(row: any): SlackEventSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    events: Array.isArray(row.events) ? row.events : JSON.parse(row.events || '[]'),
    matchPattern: row.match_pattern ?? null,
    status: row.status,
    failCount: row.fail_count,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

const SUBSCRIPTION_COLUMNS =
  'id, user_id, team_id, channel_id, events, match_pattern, status, fail_count, created_at, updated_at';

function mapEventRow(row: any): StoredSlackEvent {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    eventId: row.event_id,
    eventType: row.event_type,
    messageTs: row.message_ts ?? null,
    threadTs: row.thread_ts ?? null,
    actorId: row.actor_id ?? null,
    text: row.text ?? null,
    occurredAt: typeof row.occurred_at === 'string' ? parseInt(row.occurred_at, 10) : Number(row.occurred_at),
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    rawPayload: row.raw_payload,
  };
}

const EVENT_COLUMNS =
  'id, subscription_id, team_id, channel_id, event_id, event_type, message_ts, thread_ts, actor_id, text, occurred_at, received_at, raw_payload';

/** One subscriber's row for one channel. Backs the idempotent subscribe. */
export async function findSubscription(
  userId: number, teamId: string, channelId: string,
): Promise<SlackEventSubscription | null> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM slack_event_subscriptions
     WHERE user_id = $1 AND team_id = $2 AND channel_id = $3`,
    [userId, teamId, channelId],
  );
  return rows.length > 0 ? mapSubscriptionRow(rows[0]) : null;
}

/**
 * Every subscription interested in one channel — the fan-out target at
 * ingestion. Returns many rows on purpose: Slack sends one POST per event no
 * matter how many users are watching, so the ingest loop is what turns a
 * single delivery into per-subscriber history.
 */
export async function findSubscriptionsForChannel(
  teamId: string, channelId: string,
): Promise<SlackEventSubscription[]> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM slack_event_subscriptions
     WHERE team_id = $1 AND channel_id = $2 AND status = 'active'
     ORDER BY id`,
    [teamId, channelId],
  );
  return rows.map(mapSubscriptionRow);
}

export async function createSubscription(input: {
  userId: number;
  teamId: string;
  channelId: string;
  events: string[];
  matchPattern?: string | null;
}): Promise<SlackEventSubscription> {
  requireDb();
  const { rows } = await getPool().query(
    `INSERT INTO slack_event_subscriptions
       (user_id, team_id, channel_id, events, match_pattern, status, fail_count)
     VALUES ($1, $2, $3, $4, $5, 'active', 0)
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [input.userId, input.teamId, input.channelId, JSON.stringify(input.events), input.matchPattern ?? null],
  );
  return mapSubscriptionRow(rows[0]);
}

export async function incrementFailCount(subscriptionId: number): Promise<void> {
  requireDb();
  await getPool().query(
    `UPDATE slack_event_subscriptions
     SET fail_count = fail_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [subscriptionId],
  );
}

/**
 * Batch insert one delivery's fan-out.
 *
 * ON CONFLICT DO NOTHING against UNIQUE(subscription_id, event_id) is what
 * makes Slack's retry behaviour safe: any delivery we don't 2xx promptly comes
 * back (flagged with X-Slack-Retry-Num), and without the dedup key every event
 * in the window would land twice. The returned count is rows actually written,
 * so a fully-deduplicated retry reports 0 rather than pretending it inserted.
 */
export async function insertChannelEvents(events: SlackChannelEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  requireDb();
  const values: any[] = [];
  const placeholders: string[] = [];
  events.forEach((e, i) => {
    const b = i * 11;
    placeholders.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11})`);
    values.push(
      e.subscriptionId,
      e.teamId,
      e.channelId,
      e.eventId,
      e.eventType,
      e.messageTs,
      e.threadTs,
      e.actorId,
      e.text,
      e.occurredAt,
      JSON.stringify(e.rawPayload),
    );
  });
  const { rowCount } = await getPool().query(
    `INSERT INTO slack_channel_events
       (subscription_id, team_id, channel_id, event_id, event_type, message_ts, thread_ts, actor_id, text, occurred_at, raw_payload)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (subscription_id, event_id) DO NOTHING`,
    values,
  );
  return rowCount || 0;
}

/**
 * List a user's subscriptions. Optional channelId narrows to one. Surfaces
 * fail_count so a subscription whose ingests keep failing is visible.
 */
export async function listSubscriptionsForUser(
  userId: number, channelId?: string,
): Promise<SlackEventSubscription[]> {
  requireDb();
  const params: any[] = [userId];
  let where = 'user_id = $1';
  if (channelId) { params.push(channelId); where += ` AND channel_id = $${params.length}`; }
  const { rows } = await getPool().query(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM slack_event_subscriptions
     WHERE ${where}
     ORDER BY created_at DESC`,
    params,
  );
  return rows.map(mapSubscriptionRow);
}

/**
 * Read captured events for one subscription.
 *
 * Always scoped by subscription_id, never by channel alone — two users can
 * watch the same channel with different filters and different start times, so
 * caller B must not see rows accrued for caller A.
 */
export async function querySlackEvents(input: {
  subscriptionId: number;
  since?: number;
  until?: number;
  eventTypes?: string[];
  limit?: number;
}): Promise<StoredSlackEvent[]> {
  requireDb();
  const params: any[] = [input.subscriptionId];
  const clauses: string[] = ['subscription_id = $1'];

  if (input.since !== undefined) { params.push(input.since); clauses.push(`occurred_at >= $${params.length}`); }
  if (input.until !== undefined) { params.push(input.until); clauses.push(`occurred_at <= $${params.length}`); }
  if (input.eventTypes && input.eventTypes.length > 0) {
    params.push(input.eventTypes);
    clauses.push(`event_type = ANY($${params.length}::text[])`);
  }

  // Same reasoning as the ClickUp store: the caller renders this into a chat,
  // so cap the rows and let them narrow with `since` if they hit the cap.
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
  params.push(limit);

  const { rows } = await getPool().query(
    `SELECT ${EVENT_COLUMNS} FROM slack_channel_events
     WHERE ${clauses.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapEventRow);
}

/** Idempotent delete keyed by (user, team, channel). True when a row went. */
export async function deleteSubscription(
  userId: number, teamId: string, channelId: string,
): Promise<boolean> {
  requireDb();
  const { rowCount } = await getPool().query(
    `DELETE FROM slack_event_subscriptions WHERE user_id = $1 AND team_id = $2 AND channel_id = $3`,
    [userId, teamId, channelId],
  );
  return (rowCount || 0) > 0;
}

/**
 * Debug helper: how many events has this subscription recorded? Separates
 * "Slack never delivered" from "delivery happened but nothing persisted".
 */
export async function countChannelEventsForSubscription(subscriptionId: number): Promise<number> {
  requireDb();
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM slack_channel_events WHERE subscription_id = $1`,
    [subscriptionId],
  );
  return rows[0]?.c ?? 0;
}

export async function pruneOldChannelEvents(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  requireDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const { rowCount } = await getPool().query(
    `DELETE FROM slack_channel_events WHERE occurred_at < $1`,
    [cutoff],
  );
  return rowCount || 0;
}

let retentionTimer: NodeJS.Timeout | null = null;

// Env: SLACK_EVENT_RETENTION_DAYS (default 90), SLACK_EVENT_PRUNE_INTERVAL_MS
// (default 6h, clamped up to 1h minimum — this is overnight cleanup, not a
// real-time job).
function readRetentionConfig(): { retentionDays: number; intervalMs: number } {
  const retentionDays = Math.max(1, parseInt(process.env.SLACK_EVENT_RETENTION_DAYS || '90', 10) || 90);
  const rawInterval = parseInt(process.env.SLACK_EVENT_PRUNE_INTERVAL_MS || '', 10);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 3_600_000
    ? rawInterval
    : 6 * 60 * 60 * 1000;
  return { retentionDays, intervalMs };
}

/** Safe to call more than once; the second call is a no-op. */
export function startSlackEventRetentionScheduler(): void {
  if (retentionTimer) return;
  if (!isDatabaseAvailable()) return;
  const { retentionDays, intervalMs } = readRetentionConfig();

  const runOnce = async () => {
    try {
      const deleted = await pruneOldChannelEvents(retentionDays);
      if (deleted > 0) {
        console.error(`[slack-events] pruned ${deleted} rows older than ${retentionDays}d`);
      }
    } catch (err: any) {
      console.error('[slack-events] prune failure:', err?.message || err);
    }
  };

  retentionTimer = setInterval(runOnce, intervalMs);
  retentionTimer.unref();
  // Initial sweep so a container booting after a long outage doesn't wait a
  // full interval for the first cleanup.
  void runOnce();
}

export function stopSlackEventRetentionScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
