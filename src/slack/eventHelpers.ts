// src/slack/eventHelpers.ts
//
// Pure logic for the Slack Events API ingestion path and the three tool flows
// (subscribe / query / debug). Deliberately mirrors
// src/clickup/webhookHelpers.ts: every dependency arrives through an injected
// interface so the whole feature is testable without Postgres, without Express
// and without Slack.
//
// Where it departs from the ClickUp version, it's because Slack delivers
// differently:
//
//   - Signature scheme. ClickUp: HMAC over the raw body, hex, X-Signature.
//     Slack: HMAC over "v0:{timestamp}:{body}", prefixed "v0=", plus a
//     mandatory ±5-minute replay window on X-Slack-Request-Timestamp.
//   - A url_verification handshake exists at all (ClickUp has none): Slack POSTs
//     a challenge when the Request URL is saved and expects it echoed back.
//   - One Request URL serves the whole workspace, so ingestion looks up by
//     (team, channel) and fans out to every interested subscriber. ClickUp
//     created one webhook per subscriber, so its lookup returned a single row.
//   - Nothing is created on Slack's side when a user subscribes, so there is no
//     remote id, no per-subscription secret, and no orphan-rollback.
//
// One deliberate difference from the ClickUp log contract: this never logs a
// prefix of the request body. ClickUp's payload is task metadata; Slack's is
// message text, potentially from a private DM, and stderr is not the place for
// it. The envelope shape (type, channel, event id) is logged instead, which is
// what actually makes a delivery diagnosable.

import crypto from 'node:crypto';
import type { SlackChannelEvent, SlackEventSubscription, StoredSlackEvent } from './eventStore.js';

/**
 * Default capture bundle.
 *
 * These are Slack *event* names as they appear in `event.type`, not the
 * *subscription* names configured on the app. `message` is what arrives for
 * both `message.channels` and `message.groups`, so one entry covers both.
 * `app_mention` is intentionally absent: `app_mentions:read` is a bot-token
 * scope and this feature lives on the user-OAuth connector.
 */
export const CAPTURED_SLACK_EVENTS = ['message', 'reaction_added'] as const;
export type CapturedSlackEvent = typeof CAPTURED_SLACK_EVENTS[number];

/**
 * Membership and channel-metadata churn arrives as `message` events with a
 * subtype. It is not content, and capturing it would bury real messages in
 * join/leave noise — the same reasoning that kept `taskUpdated` out of the
 * ClickUp bundle.
 */
const IGNORED_MESSAGE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_topic', 'channel_purpose', 'channel_name',
  'channel_archive', 'channel_unarchive',
]);

/** Slack rejects a replayed request older than five minutes. */
const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

/**
 * ISO string or Unix-ms string → epoch ms; NaN when neither.
 *
 * Same semantics as ClickUp's parseTimestampInput, duplicated rather than
 * imported so the Slack module graph doesn't pull in the ClickUp client for
 * four lines. The explicit numeric branch matters: `new Date("1609459200000")`
 * is an Invalid Date, so a caller passing Unix ms as a JSON string would
 * otherwise silently fail.
 */
export function parseTimestampInput(input: string): number {
  const trimmed = input.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return new Date(trimmed).getTime();
}

// -----------------------------------------------------------------------------
// Signature verification
// -----------------------------------------------------------------------------

export type SignatureFailure = 'no-secret' | 'missing-headers' | 'stale-timestamp' | 'mismatch';
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Verify an inbound Slack request.
 *
 * Returns a tagged failure rather than a boolean so the caller can log and
 * report the three genuinely different causes distinctly: nothing configured,
 * a replay outside the window, and an actual signature mismatch. Conflating
 * them is what makes "Slack says my Request URL failed" undebuggable.
 */
export function verifySlackSignature(
  signingSecret: string | undefined,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): SignatureResult {
  if (!signingSecret) return { ok: false, reason: 'no-secret' };
  if (!signatureHeader || !timestampHeader) return { ok: false, reason: 'missing-headers' };

  const timestamp = parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing-headers' };
  if (Math.abs(nowMs / 1000 - timestamp) > MAX_TIMESTAMP_SKEW_SEC) {
    return { ok: false, reason: 'stale-timestamp' };
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');

  if (expected.length !== signatureHeader.length) return { ok: false, reason: 'mismatch' };
  try {
    const equal = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signatureHeader, 'utf8'));
    return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
  } catch {
    return { ok: false, reason: 'mismatch' };
  }
}

// -----------------------------------------------------------------------------
// Payload parsing
// -----------------------------------------------------------------------------

export interface ParsedSlackEvent {
  eventId: string;
  eventType: string;
  teamId: string;
  channelId: string;
  messageTs: string | null;
  threadTs: string | null;
  actorId: string | null;
  text: string | null;
  occurredAt: number;
  raw: any;
}

/** Slack sends float-seconds strings; the store keeps epoch millis. */
function tsToMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 1000);
  }
  return null;
}

/**
 * Normalise one `event_callback` envelope into a row-shaped object.
 *
 * The non-obvious part is `reaction_added`: its channel and message timestamp
 * live under `event.item`, not on the event itself, so reading `event.channel`
 * would silently drop every reaction. `event.ts` is likewise the reaction's own
 * timestamp for reactions and the message's for messages — hence event_ts
 * first, falling back to ts and then the envelope's event_time.
 */
export function parseSlackEventPayload(
  envelope: any,
): { ok: true; event: ParsedSlackEvent } | { ok: false; reason: string } {
  const event = envelope?.event;
  if (!event || typeof event !== 'object') return { ok: false, reason: 'envelope has no event object' };

  const eventType = typeof event.type === 'string' ? event.type : '';
  if (!eventType) return { ok: false, reason: 'event has no type' };

  const eventId = envelope?.event_id ? String(envelope.event_id) : '';
  if (!eventId) return { ok: false, reason: 'envelope has no event_id (needed to deduplicate retries)' };

  const teamId = String(envelope?.team_id || event.team || '');
  if (!teamId) return { ok: false, reason: 'envelope has no team_id' };

  const channelId = String(event.channel || event.item?.channel || '');
  if (!channelId) return { ok: false, reason: `event type "${eventType}" carries no channel` };

  if (eventType === 'message' && event.subtype && IGNORED_MESSAGE_SUBTYPES.has(String(event.subtype))) {
    return { ok: false, reason: `ignored message subtype "${event.subtype}"` };
  }

  const occurredAt =
    tsToMillis(event.event_ts) ??
    tsToMillis(event.ts) ??
    tsToMillis(envelope?.event_time) ??
    null;
  if (occurredAt === null) return { ok: false, reason: 'event has no usable timestamp' };

  // A reaction has no text of its own; recording the emoji keeps the row
  // readable and gives matchPattern something to match on.
  const text = eventType === 'reaction_added'
    ? (event.reaction ? `:${event.reaction}:` : null)
    : (typeof event.text === 'string' ? event.text : null);

  return {
    ok: true,
    event: {
      eventId,
      eventType,
      teamId,
      channelId,
      messageTs: event.item?.ts ? String(event.item.ts) : (event.ts ? String(event.ts) : null),
      threadTs: event.thread_ts ? String(event.thread_ts) : null,
      actorId: event.user ? String(event.user) : null,
      text,
      occurredAt,
      raw: event,
    },
  };
}

/** Does this subscription want this event? Event type first, then matchPattern. */
export function matchesSubscription(sub: SlackEventSubscription, event: ParsedSlackEvent): boolean {
  if (!sub.events.includes(event.eventType)) return false;
  if (!sub.matchPattern) return true;
  // Case-insensitive substring: a plain-language filter ("LinkedIn") should
  // work without the caller learning a regex dialect, and an un-escaped regex
  // from an LLM is a denial-of-service waiting to happen.
  return (event.text || '').toLowerCase().includes(sub.matchPattern.toLowerCase());
}

// -----------------------------------------------------------------------------
// Ingestion
// -----------------------------------------------------------------------------

/** Only what ingestion uses, so tests can inject an in-memory fake. */
export interface SlackIngestionStore {
  findSubscriptionsForChannel(teamId: string, channelId: string): Promise<SlackEventSubscription[]>;
  insertChannelEvents(events: SlackChannelEvent[]): Promise<number>;
  incrementFailCount(subscriptionId: number): Promise<void>;
}

export interface SlackIngestHeaders {
  signature?: string;
  timestamp?: string;
  /** X-Slack-Retry-Num — present only on a redelivery. */
  retryNum?: string;
}

export type IngestBranch =
  | 'ok'
  | 'url-verification'
  | 'bad-json'
  | 'bad-signature'
  | 'stale-timestamp'
  | 'no-secret'
  | 'unsupported-envelope'
  | 'unparseable-event'
  | 'no-subscription'
  | 'no-match'
  | 'lookup-failed'
  | 'insert-failed';

/**
 * Everything needed to explain why a delivery went the way it did, with no
 * message text: `text` is the user's content, and a private DM's body has no
 * business in stderr. See the module header.
 */
export interface SlackIngestLogContext {
  branch: IngestBranch;
  envelopeType: string | null;
  eventType: string | null;
  eventId: string | null;
  teamId: string | null;
  channelId: string | null;
  sigPresent: boolean;
  isRetry: boolean;
  bodyLen: number;
  matchedSubscriptions?: number;
  insertedEventCount?: number;
  failCountBumped: boolean;
}

export interface SlackIngestResult {
  status: 200 | 400 | 401;
  body: { ok: true } | { challenge: string } | { error: string };
  insertedEventCount?: number;
  logContext: SlackIngestLogContext;
}

/**
 * Pure ingestion given the raw body, the Slack headers, a store and the
 * app-level signing secret.
 *
 * Status contract — note it is NOT ClickUp's, because Slack disables the whole
 * Request URL (every subscriber, every channel) after sustained non-2xx,
 * whereas ClickUp disabled one webhook belonging to one user:
 *
 *   200 + challenge → url_verification handshake, signature checked first
 *   200             → verified and stored (insertedEventCount reflects rows;
 *                     a deduplicated retry legitimately reports 0)
 *   200             → verified but nobody is subscribed, no subscription
 *                     matched, or the event isn't one we capture. Nothing to
 *                     charge and nothing to retry, so don't risk the URL.
 *   200 + bumps     → verified but the insert threw (DB blip). Treated as
 *                     transient, fail_count bumped per affected subscription.
 *   401             → signature missing/stale/mismatched, or no secret
 *                     configured. Permanent and worth Slack surfacing.
 *   400             → unparseable JSON.
 */
export async function handleSlackEventIngest(
  rawBody: Buffer | string,
  headers: SlackIngestHeaders,
  store: SlackIngestionStore,
  signingSecret: string | undefined,
  nowMs: number = Date.now(),
): Promise<SlackIngestResult> {
  const buf: Buffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;

  const baseCtx: SlackIngestLogContext = {
    branch: 'ok',
    envelopeType: null,
    eventType: null,
    eventId: null,
    teamId: null,
    channelId: null,
    sigPresent: !!headers.signature,
    isRetry: !!headers.retryNum,
    bodyLen: buf.length,
    failCountBumped: false,
  };

  let envelope: any;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body' }, logContext: { ...baseCtx, branch: 'bad-json' } };
  }

  const envelopeType = typeof envelope?.type === 'string' ? envelope.type : null;
  baseCtx.envelopeType = envelopeType;

  // Signature is checked before anything else is trusted — including the
  // url_verification challenge, which Slack also signs.
  const verified = verifySlackSignature(signingSecret, buf, headers.signature, headers.timestamp, nowMs);
  if (!verified.ok) {
    const branch: IngestBranch =
      verified.reason === 'stale-timestamp' ? 'stale-timestamp'
      : verified.reason === 'no-secret' ? 'no-secret'
      : 'bad-signature';
    const error =
      verified.reason === 'no-secret'
        ? 'SLACK_SIGNING_SECRET is not configured on this deployment'
        : verified.reason === 'stale-timestamp'
          ? 'Request timestamp outside the allowed window'
          : 'Invalid signature';
    return { status: 401, body: { error }, logContext: { ...baseCtx, branch } };
  }

  if (envelopeType === 'url_verification') {
    const challenge = typeof envelope?.challenge === 'string' ? envelope.challenge : '';
    if (!challenge) {
      return { status: 400, body: { error: 'url_verification without a challenge' }, logContext: { ...baseCtx, branch: 'bad-json' } };
    }
    return { status: 200, body: { challenge }, logContext: { ...baseCtx, branch: 'url-verification' } };
  }

  if (envelopeType !== 'event_callback') {
    return { status: 200, body: { ok: true }, logContext: { ...baseCtx, branch: 'unsupported-envelope' } };
  }

  const parsed = parseSlackEventPayload(envelope);
  if (!parsed.ok) {
    // Not an error on Slack's side — we subscribe at the app level and get
    // events we don't store (ignored subtypes, channel-less events).
    return {
      status: 200,
      body: { ok: true },
      logContext: { ...baseCtx, branch: 'unparseable-event', eventType: envelope?.event?.type ?? null },
    };
  }

  const event = parsed.event;
  baseCtx.eventType = event.eventType;
  baseCtx.eventId = event.eventId;
  baseCtx.teamId = event.teamId;
  baseCtx.channelId = event.channelId;

  let subs: SlackEventSubscription[];
  try {
    subs = await store.findSubscriptionsForChannel(event.teamId, event.channelId);
  } catch (err: any) {
    console.error(`[slack-ingest] subscription lookup failure for event ${event.eventId}:`, err?.message || err);
    // Same reasoning as the insert-failure branch below: a DB blip is ours, and
    // letting this reach the route's 500 would risk Slack disabling the Request
    // URL for every subscriber in the workspace. No fail-count bump — we never
    // learned which subscriptions were involved.
    return {
      status: 200,
      body: { ok: true },
      insertedEventCount: 0,
      logContext: { ...baseCtx, branch: 'lookup-failed', matchedSubscriptions: 0, insertedEventCount: 0 },
    };
  }
  if (subs.length === 0) {
    return { status: 200, body: { ok: true }, logContext: { ...baseCtx, branch: 'no-subscription', matchedSubscriptions: 0 } };
  }

  // The fan-out: one delivery becomes one row per interested subscriber, so
  // two users watching the same channel each get their own history with their
  // own start time and their own filter.
  const matched = subs.filter(sub => matchesSubscription(sub, event));
  if (matched.length === 0) {
    return { status: 200, body: { ok: true }, logContext: { ...baseCtx, branch: 'no-match', matchedSubscriptions: 0 } };
  }

  const rows: SlackChannelEvent[] = matched.map(sub => ({
    subscriptionId: sub.id,
    teamId: event.teamId,
    channelId: event.channelId,
    eventId: event.eventId,
    eventType: event.eventType,
    messageTs: event.messageTs,
    threadTs: event.threadTs,
    actorId: event.actorId,
    text: event.text,
    occurredAt: event.occurredAt,
    rawPayload: event.raw,
  }));

  let insertedEventCount: number;
  try {
    insertedEventCount = await store.insertChannelEvents(rows);
  } catch (err: any) {
    console.error(`[slack-ingest] insert failure for event ${event.eventId}:`, err?.message || err);
    let failCountBumped = false;
    for (const sub of matched) {
      try { await store.incrementFailCount(sub.id); failCountBumped = true; } catch { /* best-effort */ }
    }
    // Still 200: a DB blip is ours, and a non-2xx here risks Slack disabling
    // the Request URL for every subscriber in the workspace.
    return {
      status: 200,
      body: { ok: true },
      insertedEventCount: 0,
      logContext: { ...baseCtx, branch: 'insert-failed', matchedSubscriptions: matched.length, insertedEventCount: 0, failCountBumped },
    };
  }

  return {
    status: 200,
    body: { ok: true },
    insertedEventCount,
    logContext: { ...baseCtx, branch: 'ok', matchedSubscriptions: matched.length, insertedEventCount },
  };
}

// -----------------------------------------------------------------------------
// Subscribe flow
// -----------------------------------------------------------------------------

export interface SlackSubscribeDeps {
  findSubscription(userId: number, teamId: string, channelId: string): Promise<SlackEventSubscription | null>;
  createSubscription(input: {
    userId: number; teamId: string; channelId: string; events: string[]; matchPattern?: string | null;
  }): Promise<SlackEventSubscription>;
}

export interface SlackSubscribeResult {
  kind: 'created' | 'existing';
  subscription: SlackEventSubscription;
}

/**
 * Idempotent on (user, team, channel).
 *
 * Far simpler than the ClickUp equivalent because nothing is created remotely:
 * Slack event subscriptions are configured once on the app, so there is no
 * webhook to create, no secret to store, and no orphan to roll back if the
 * insert fails.
 */
export async function subscribeToChannelEventsFlow(
  deps: SlackSubscribeDeps,
  input: { userId: number; teamId: string; channelId: string; events: string[]; matchPattern?: string | null },
): Promise<SlackSubscribeResult> {
  const existing = await deps.findSubscription(input.userId, input.teamId, input.channelId);
  if (existing) return { kind: 'existing', subscription: existing };
  const subscription = await deps.createSubscription(input);
  return { kind: 'created', subscription };
}

// -----------------------------------------------------------------------------
// Query flow
// -----------------------------------------------------------------------------

export interface SlackQueryResult {
  kind: 'ok' | 'no-subscription';
  subscription?: SlackEventSubscription;
  events: StoredSlackEvent[];
  eventStoreStartedAt?: string;
  warning?: string;
}

export interface SlackQueryDeps {
  findSubscription(userId: number, teamId: string, channelId: string): Promise<SlackEventSubscription | null>;
  querySlackEvents(input: {
    subscriptionId: number; since?: number; until?: number; eventTypes?: string[]; limit?: number;
  }): Promise<StoredSlackEvent[]>;
}

/**
 * Read a channel's captured history, telling the caller when the store simply
 * wasn't listening yet rather than implying nothing happened. Both fallbacks
 * point at readChannelHistory, which can still reach the earlier window.
 */
export async function querySlackEventsFlow(
  deps: SlackQueryDeps,
  input: {
    userId: number; teamId: string; channelId: string;
    since?: number; until?: number; eventTypes?: string[]; limit?: number;
  },
): Promise<SlackQueryResult> {
  const sub = await deps.findSubscription(input.userId, input.teamId, input.channelId);
  if (!sub) {
    return {
      kind: 'no-subscription',
      events: [],
      warning:
        `No channel-event subscription exists for ${input.channelId}. ` +
        'Call subscribeToChannelEvents first — history accrues from that moment forward. ' +
        'For anything earlier, use readChannelHistory.',
    };
  }

  const events = await deps.querySlackEvents({
    subscriptionId: sub.id,
    since: input.since,
    until: input.until,
    eventTypes: input.eventTypes,
    limit: input.limit,
  });

  let warning: string | undefined;
  if (input.since !== undefined) {
    const subStartMs = Date.parse(sub.createdAt);
    if (Number.isFinite(subStartMs) && input.since < subStartMs) {
      warning =
        `Query 'since' predates subscription creation (${sub.createdAt}). ` +
        'Events before that timestamp are not in the store — use readChannelHistory ' +
        'with `oldest` for that earlier window.';
    }
  }

  return { kind: 'ok', subscription: sub, events, eventStoreStartedAt: sub.createdAt, warning };
}

// -----------------------------------------------------------------------------
// Debug flow
// -----------------------------------------------------------------------------

export interface SlackDebugReport {
  kind: 'ok' | 'no-local-subscription';
  channelId: string;
  expectedRequestUrl: string;
  signingSecretConfigured: boolean;
  local?: {
    id: number;
    events: string[];
    matchPattern: string | null;
    status: string;
    failCount: number;
    createdAt: string;
  };
  channel?: { name: string | null; isMember: boolean | null };
  eventStore?: { count: number; mostRecentOccurredAt: number | null; mostRecentReceivedAt: string | null };
  findings: string[];
}

export interface SlackDebugDeps {
  findSubscription(userId: number, teamId: string, channelId: string): Promise<SlackEventSubscription | null>;
  countChannelEventsForSubscription(subscriptionId: number): Promise<number>;
  querySlackEvents(input: { subscriptionId: number; limit?: number }): Promise<StoredSlackEvent[]>;
  /** conversations.info, for the membership check. Optional so tests can omit it. */
  getChannelInfo?(channelId: string): Promise<{ name?: string; is_member?: boolean }>;
}

/**
 * Diagnose a subscription that reports success but isn't accruing events.
 *
 * The findings differ from the ClickUp tool's on purpose. Four of that tool's
 * six checks read ClickUp's own `webhooks[].health` and compare the stored
 * endpoint against BASE_URL; Slack exposes neither a per-subscriber webhook
 * list nor delivery health, so there is nothing to reconcile against. What
 * replaces them are the things that actually silence a Slack Request URL:
 * a missing signing secret, a Request URL the operator never configured, and
 * an app that isn't in the channel.
 */
export async function debugChannelEventSubscriptionFlow(
  deps: SlackDebugDeps,
  input: { userId: number; teamId: string; channelId: string; expectedRequestUrl: string; signingSecretConfigured: boolean },
): Promise<SlackDebugReport> {
  const findings: string[] = [];
  const report: SlackDebugReport = {
    kind: 'ok',
    channelId: input.channelId,
    expectedRequestUrl: input.expectedRequestUrl,
    signingSecretConfigured: input.signingSecretConfigured,
    findings,
  };

  const localSub = await deps.findSubscription(input.userId, input.teamId, input.channelId);
  if (localSub) {
    report.local = {
      id: localSub.id,
      events: localSub.events,
      matchPattern: localSub.matchPattern,
      status: localSub.status,
      failCount: localSub.failCount,
      createdAt: localSub.createdAt,
    };
  } else {
    report.kind = 'no-local-subscription';
    findings.push(
      'No local subscription for this (user, channel). Call subscribeToChannelEvents first, or check you are logged in as the same user who subscribed.',
    );
  }

  // Deployment-level checks. Both of these silence every subscription at once,
  // so they are worth reporting even when the local record looks perfect.
  if (!input.signingSecretConfigured) {
    findings.push(
      'SLACK_SIGNING_SECRET is not set on this deployment. Every inbound delivery is rejected with 401 before it can be stored, and Slack cannot verify the Request URL at all. Set it from the Slack app\'s Basic Information page and redeploy.',
    );
  }
  if (!input.expectedRequestUrl) {
    findings.push(
      'BASE_URL is not set, so the Request URL to configure in Slack cannot be derived. Set BASE_URL, then point the Slack app\'s Event Subscriptions Request URL at ${BASE_URL}/webhooks/slack/inbound.',
    );
  } else {
    findings.push(
      `Request URL to configure in the Slack app: ${input.expectedRequestUrl}. Slack does not expose what URL it is delivering to, so compare this against the app's Event Subscriptions page by hand — a stale URL there is the closest analogue to ClickUp's endpoint drift and produces exactly this symptom.`,
    );
  }

  // Membership: Slack does not deliver message events for a channel the
  // installation isn't in. This is the most common "subscription looks fine,
  // nothing arrives" cause that IS checkable from our side.
  if (deps.getChannelInfo) {
    try {
      const info = await deps.getChannelInfo(input.channelId);
      report.channel = {
        name: info?.name ?? null,
        isMember: typeof info?.is_member === 'boolean' ? info.is_member : null,
      };
      if (report.channel.isMember === false) {
        findings.push(
          `Not a member of #${report.channel.name || input.channelId}. Slack only delivers message events for channels the installation belongs to — join the channel, then events will start arriving.`,
        );
      }
    } catch (err: any) {
      findings.push(`Failed to fetch channel info: ${err?.message || err}. Skipping the membership check.`);
    }
  }

  if (localSub) {
    if (localSub.status !== 'active') {
      findings.push(`Subscription status is "${localSub.status}", so ingestion skips it. Unsubscribe and re-subscribe to reset.`);
    }
    if (localSub.failCount > 0) {
      findings.push(
        `Local fail_count is ${localSub.failCount}: deliveries reached this process but could not be stored (or arrived unsigned). Grep the logs for "[slack-ingest]" — the branch field on each line says which.`,
      );
    }

    let count = 0;
    try { count = await deps.countChannelEventsForSubscription(localSub.id); }
    catch (err: any) { findings.push(`Failed to count events: ${err?.message || err}`); }

    let mostRecent: StoredSlackEvent | undefined;
    try {
      const recent = await deps.querySlackEvents({ subscriptionId: localSub.id, limit: 1 });
      mostRecent = recent[0];
    } catch (err: any) {
      findings.push(`Failed to fetch most recent event: ${err?.message || err}`);
    }

    report.eventStore = {
      count,
      mostRecentOccurredAt: mostRecent?.occurredAt ?? null,
      mostRecentReceivedAt: mostRecent?.receivedAt ?? null,
    };

    // The one ClickUp finding that ports directly: nothing stored, nothing
    // failed. Age gates it so a subscription created seconds ago isn't
    // reported as broken.
    if (count === 0 && localSub.failCount === 0) {
      const created = Date.parse(localSub.createdAt);
      const ageMinutes = Number.isFinite(created) ? Math.round((Date.now() - created) / 60000) : NaN;
      findings.push(
        `Zero events stored and zero local failures (subscription age: ${Number.isFinite(ageMinutes) ? ageMinutes + 'm' : 'unknown'}). If events have genuinely fired in that window, deliveries are not reaching this process at all — check the Request URL above, that Event Subscriptions is enabled for message.channels/message.groups/reaction_added, and that the matchPattern (${localSub.matchPattern ? `"${localSub.matchPattern}"` : 'none'}) isn't filtering everything out.`,
      );
    }
  }

  if (findings.length === 0) {
    findings.push('No anomalies detected.');
  }
  return report;
}
