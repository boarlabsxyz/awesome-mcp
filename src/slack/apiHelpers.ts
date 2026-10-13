// src/slack/apiHelpers.ts
import { UserError } from 'fastmcp';
import { fetchSlackFileBytes, type SlackFileBytes } from './fileDownload.js';

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * A file as it appears on a message (`files[]`) or from files.info.
 *
 * Every field is optional on purpose. Slack returns heavily reduced objects for
 * files the token can't see (`file_access`) and for deleted ones
 * (`mode: 'tombstone'`), so anything that renders these must degrade rather
 * than assume `name`/`mimetype`/`size` are present.
 */
export interface SlackFileRef {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  /** 'hosted' | 'snippet' | 'post' | 'external' | 'tombstone' | … */
  mode?: string;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
  is_external?: boolean;
  /** 'check_file_info' | 'access_denied' when Slack withholds the file. */
  file_access?: string;
}

/** files.info adds share targets and the uploader to the base file shape. */
export interface SlackFileInfo extends SlackFileRef {
  user?: string;
  created?: number;
  preview?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  shares?: {
    public?: Record<string, unknown>;
    private?: Record<string, unknown>;
  };
}

/**
 * Every channel/DM a file is shared into.
 *
 * Slack exposes this two ways — the flat `channels`/`groups`/`ims` arrays and
 * the newer `shares.public`/`shares.private` maps keyed by channel ID. Union
 * both so share verification doesn't silently come up empty on either shape.
 */
export function fileShareTargets(file: SlackFileInfo): Set<string> {
  const targets = new Set<string>();
  for (const id of [...(file.channels || []), ...(file.groups || []), ...(file.ims || [])]) {
    if (id) targets.add(id);
  }
  for (const bucket of [file.shares?.public, file.shares?.private]) {
    for (const id of Object.keys(bucket || {})) targets.add(id);
  }
  return targets;
}

/**
 * The fields Slack can put a team (workspace/org) ID into on a channel payload.
 *
 * Everything here used to read `shared_team_ids` alone. That is the wrong field
 * on its own for Slack Connect: the external orgs routinely arrive in
 * `connected_team_ids` (and in `pending_connected_team_ids` while an invite is
 * still outstanding) while `shared_team_ids` carries only the internal side.
 * Reading one field made an external org invisible to org discovery *and* made
 * `assertAccess` reject a channel as "organisation could not be verified" that
 * was in fact shared with an allowed org. Both callers go through
 * `channelTeamIds` so they cannot disagree about which orgs a channel touches.
 */
export interface SlackChannelTeamFields {
  shared_team_ids?: string[];
  internal_team_ids?: string[];
  connected_team_ids?: string[];
  pending_connected_team_ids?: string[];
  /** Older sibling of `pending_connected_team_ids`; Slack still sends it. */
  pending_shared?: string[];
  /**
   * The team whose *view* the payload was rendered for — normally the caller's
   * own workspace. It says nothing about who the channel is shared with, which
   * is why `channelSharedTeamIds` excludes it.
   */
  context_team_id?: string;
}

/**
 * The orgs a channel is actually shared with, from Slack's team-ID *lists*.
 *
 * Deliberately excludes `context_team_id`: that is the viewing workspace, so a
 * Slack Connect payload carrying nothing but `context_team_id` names no partner
 * at all. Discovery gates its `conversations.info` enrichment on this — gating
 * on `channelTeamIds` treated such a payload as already resolved and dropped
 * the external org.
 */
export function channelSharedTeamIds(
  channel: SlackChannelTeamFields | undefined | null,
  options?: { includePending?: boolean },
): string[] {
  if (!channel) return [];
  const ids = new Set<string>();
  const lists = [channel.shared_team_ids, channel.internal_team_ids, channel.connected_team_ids];
  if (options?.includePending) lists.push(channel.pending_connected_team_ids, channel.pending_shared);
  for (const list of lists) {
    for (const id of list || []) if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Every team ID a channel payload mentions, de-duplicated — the shared lists
 * plus `context_team_id`.
 *
 * `includePending` covers orgs that have been *invited* to the channel but have
 * not accepted. Discovery wants them (so the org is tickable before the invite
 * lands); access enforcement does not (an outstanding invite must not deny a
 * channel that org cannot read yet).
 */
export function channelTeamIds(
  channel: SlackChannelTeamFields | undefined | null,
  options?: { includePending?: boolean },
): string[] {
  if (!channel) return [];
  const ids = new Set<string>(channelSharedTeamIds(channel, options));
  if (channel.context_team_id) ids.add(channel.context_team_id);
  return [...ids];
}

/** Channel flags that mean "this conversation reaches beyond this workspace". */
export interface SlackChannelSharedFlags {
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_org_shared?: boolean;
  /** Slack Connect invite sent but not yet accepted — `is_ext_shared` is still false. */
  is_pending_ext_shared?: boolean;
}

/** True when a channel is shared with (or pending sharing with) another org. */
export function isSharedChannel(channel: SlackChannelSharedFlags): boolean {
  return !!(channel.is_shared || channel.is_ext_shared || channel.is_org_shared || channel.is_pending_ext_shared);
}

// === Search ===

export interface SlackSearchOptions {
  /** Results per page (1-100). */
  count?: number;
  /** 1-based page number. search.* pages by number, not by cursor. */
  page?: number;
  sort?: 'score' | 'timestamp';
  sortDir?: 'asc' | 'desc';
}

/**
 * search.* pages by number, unlike every other Slack method in this file
 * (which uses `response_metadata.next_cursor`). `paging` is the legacy block
 * and `pagination` the newer one; Slack still sends both, so read either.
 */
export interface SlackSearchPage<T> {
  total: number;
  matches: T[];
  paging?: { count: number; total: number; page: number; pages: number };
  pagination?: { total_count: number; page: number; per_page: number; page_count: number };
}

/** The reduced channel object search.* attaches to each match. */
export interface SlackSearchChannelRef {
  id: string;
  name?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

export interface SlackMessageMatch {
  type?: string;
  channel: SlackSearchChannelRef;
  user?: string;
  username?: string;
  ts: string;
  text: string;
  /** search.* returns this directly, so callers needn't build it. */
  permalink?: string;
  files?: SlackFileRef[];
}

/** A file match carries the same share targets files.info does. */
export interface SlackFileMatch extends SlackFileInfo {
  channels?: string[];
}

/** Slack caps `count` at 100 and `page` at 100. */
function buildSearchBody(query: string, options?: SlackSearchOptions): Record<string, unknown> {
  return {
    query,
    count: Math.min(Math.max(options?.count ?? 20, 1), 100),
    page: Math.min(Math.max(options?.page ?? 1, 1), 100),
    ...(options?.sort ? { sort: options.sort } : {}),
    ...(options?.sortDir ? { sort_dir: options.sortDir } : {}),
  };
}

/**
 * Append Slack's own scope accounting to a missing_scope failure.
 *
 * Slack returns `needed` and `provided` alongside the error, and dropping them
 * is what makes a scope failure undebuggable: "reconnect to re-consent" gives
 * no way to tell a reconnect that never happened from one that happened and
 * still did not grant the scope. `provided` is the authoritative list of what
 * the stored token actually carries, so it answers both at once.
 */
function formatScopeDetail(data: any): string {
  if (data?.error !== 'missing_scope') return '';
  const needed = typeof data.needed === 'string' ? data.needed : '';
  const provided = typeof data.provided === 'string' ? data.provided : '';
  if (!needed && !provided) return '';
  const parts: string[] = [];
  if (needed) parts.push(`needed: ${needed}`);
  if (provided) parts.push(`token currently has: ${provided}`);
  return ` (${parts.join('; ')})`;
}

/**
 * Per-message control over Slack's link previews ("unfurls").
 *
 * Both flags are optional, and an omitted one is left out of the request body
 * entirely rather than sent as `false` — because Slack's own default is not a
 * single value. A bot-token post does not unfurl primarily text-based links by
 * default but does unfurl media; a user-token post behaves like a human's and
 * unfurls both. Sending `false` for a flag the caller never set would silently
 * change behaviour on one of those paths, so "omitted" has to stay
 * distinguishable from "off".
 */
export interface SlackUnfurlOptions {
  /** `false` suppresses previews for primarily text-based links. */
  unfurlLinks?: boolean;
  /** `false` suppresses previews for media (image, video) links. */
  unfurlMedia?: boolean;
}

/**
 * How the message body is expressed, beyond plain mrkdwn `text`.
 *
 * Slack's mrkdwn has no list syntax at all, so `- item` and `1. item` in `text`
 * arrive as a literal hyphen and a literal digit. There are exactly two routes
 * to real list elements and both live here:
 *
 * - `markdownText` → the `markdown_text` argument, which Slack converts into
 *   blocks server-side. It supports ordered and unordered lists, headings,
 *   blockquote, code blocks and tables, and is capped at 12,000 characters.
 *   Slack documents it as mutually exclusive with BOTH `text` and `blocks`
 *   (`markdown_text_conflict`), which is why `resolveMessageBody` in
 *   `helpers.ts` refuses the combination before anything is written.
 * - `blocks` → a Block Kit array, the escape hatch for `rich_text` /
 *   `rich_text_list` and for multi-section layouts. `text` is still wanted
 *   alongside it as the notification and accessibility fallback.
 */
export interface SlackMessageContent {
  /**
   * Block Kit blocks. Serialised with `JSON.stringify` by the client methods
   * below, NOT by the caller — `request()` form-encodes every value through
   * `String(v)`, so an array handed straight to it becomes the literal
   * `[object Object]` and Slack answers a bare `invalid_blocks_format`.
   * Keeping the serialisation in one place is what stops a future call site
   * from skipping it.
   */
  blocks?: unknown[];
  /** Standard markdown; becomes `markdown_text`. Replaces `text` entirely. */
  markdownText?: string;
}

/** Everything `chat.postMessage` accepts here. */
export interface SlackPostOptions extends SlackUnfurlOptions, SlackMessageContent {
  /**
   * `reply_broadcast` — also send a thread reply to the channel (the "Also
   * send to channel" checkbox). Only meaningful with `thread_ts`.
   *
   * Omitted rather than sent as `false` when unset, for the same reason the
   * unfurl flags are. Slack's documented default here IS `false`, so this is
   * consistency rather than necessity — but it keeps one rule for every
   * optional boolean in this file.
   */
  broadcast?: boolean;
}

/**
 * Everything `chat.update` accepts here.
 *
 * No `broadcast`: Slack's `chat.update` reference does list `reply_broadcast`
 * ("Broadcast an existing thread reply to make it visible to everyone"), but
 * that has not been exercised end-to-end and the response does not echo the
 * flag, so a no-op would be indistinguishable from success — the same call as
 * the declined Browserbase `timeoutSeconds`. The unfurl flags are absent for
 * the reason already recorded on `handleEditMessage`.
 */
export type SlackUpdateOptions = SlackMessageContent;

/**
 * The message `chat.postMessage` / `chat.update` echo back.
 *
 * This is the evidence the unfurl flags never had. Those answer with `ts` and
 * `channel` and carry no unfurl state, so the confirmation could only report
 * what was *requested*. A posted message, by contrast, comes back with the
 * blocks Slack actually stored — which is the only way to answer "are there
 * list elements in it?" without opening Slack, and that is precisely the
 * question that went unanswered when `markdownText` did not exist.
 */
export interface SlackPostedMessage {
  text?: string;
  /** `thread_broadcast` on a reply that was broadcast to the channel. */
  subtype?: string;
  blocks?: Array<{ type?: string; elements?: Array<{ type?: string }> }>;
}

export class SlackClient {
  constructor(private botToken: string) {}

  private async request<T = any>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${SLACK_API_BASE}/${method}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    // Some Slack API methods (conversations.replies, conversations.history, etc.)
    // don't reliably accept JSON bodies. Use form-urlencoded for compatibility.
    const formBody = body
      ? Object.entries(body)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : undefined;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new UserError(`Slack API request timed out: ${method}`);
      }
      throw new UserError(`Slack API request failed (${method}): ${err.message || err}`);
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      const waitMs = Math.min(retryAfter * 1000, 30_000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      // Retry once after waiting
      const retryRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
      });
      if (retryRes.status === 429) {
        throw new UserError(`Slack rate limit exceeded. Try again in a moment.`);
      }
      if (!retryRes.ok) {
        const errText = await retryRes.text();
        throw new UserError(`Slack API HTTP error (${retryRes.status}): ${errText}`);
      }
      const retryData = await retryRes.json() as any;
      if (!retryData.ok) {
        throw new UserError(`Slack API error (${method}): ${retryData.error || 'unknown error'}${formatScopeDetail(retryData)}`);
      }
      return retryData as T;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new UserError(`Slack API HTTP error (${res.status}): ${errText}`);
    }

    const data = await res.json() as any;

    // Slack returns 200 with ok:false for API errors
    if (!data.ok) {
      throw new UserError(`Slack API error (${method}): ${data.error || 'unknown error'}${formatScopeDetail(data)}`);
    }

    return data as T;
  }

  // === Auth ===

  async authTest(): Promise<{ ok: boolean; user_id: string; team: string; team_id: string; bot_id?: string; url: string }> {
    return this.request('auth.test');
  }

  // === Conversations ===

  async conversationsList(cursor?: string, types?: string): Promise<{
    channels: Array<SlackChannelTeamFields & {
      id: string; name: string; is_private: boolean; is_archived: boolean;
      is_shared?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean;
      is_pending_ext_shared?: boolean;
      is_im?: boolean; is_mpim?: boolean;
      user?: string; // DM partner user ID (for im type)
      topic?: { value: string }; purpose?: { value: string }; num_members?: number;
    }>;
    response_metadata?: { next_cursor?: string };
  }> {
    // users.conversations returns only channels the bot/user is a member of,
    // unlike conversations.list which returns all visible channels.
    return this.request('users.conversations', {
      types: types || 'public_channel,private_channel,im',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
  }

  /** List ALL channels in the workspace (not just joined). Uses conversations.list. */
  async conversationsListAll(cursor?: string, types?: string): Promise<{
    channels: Array<SlackChannelTeamFields & {
      id: string; name: string; is_private: boolean; is_archived: boolean;
      is_shared?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean;
      is_pending_ext_shared?: boolean;
      is_im?: boolean; is_mpim?: boolean;
      user?: string;
      topic?: { value: string }; purpose?: { value: string }; num_members?: number;
    }>;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('conversations.list', {
      types: types || 'public_channel,private_channel',
      exclude_archived: true,
      // 1000 is Slack's documented maximum for this method. At 200 a workspace
      // with >5k channels exhausted org discovery's page budget before reaching
      // its externally-shared channels, so an org the user was plainly in went
      // untickable. Slack may return fewer than asked; the cursor loop already
      // handles short pages.
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
  }

  async conversationsHistory(channel: string, options?: {
    limit?: number; oldest?: string; latest?: string; cursor?: string;
  }): Promise<{
    messages: Array<{
      type: string; user?: string; text: string; ts: string;
      thread_ts?: string; reply_count?: number; subtype?: string;
      files?: SlackFileRef[];
    }>;
    has_more: boolean;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('conversations.history', {
      channel,
      limit: options?.limit ?? 20,
      ...(options?.oldest ? { oldest: options.oldest } : {}),
      ...(options?.latest ? { latest: options.latest } : {}),
      ...(options?.cursor ? { cursor: options.cursor } : {}),
    });
  }

  async conversationsReplies(channel: string, ts: string, options?: {
    limit?: number; cursor?: string;
  }): Promise<{
    messages: Array<{
      type: string; user?: string; text: string; ts: string;
      thread_ts?: string; reply_count?: number; subtype?: string;
      files?: SlackFileRef[];
    }>;
    has_more: boolean;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('conversations.replies', {
      channel,
      ts,
      limit: options?.limit ?? 50,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
    });
  }

  // === Chat ===

  /**
   * Post a message — plain mrkdwn `text`, `markdownText`, or Block Kit
   * `blocks` — optionally in a thread, broadcast to the channel, and with
   * Slack's link previews suppressed.
   *
   * Every optional field is spread in only when set. `request()` already drops
   * `undefined` from the form body, but writing the condition out here keeps
   * the omitted-is-not-false invariant (see `SlackUnfurlOptions`) from
   * depending on a filter several hundred lines away.
   *
   * `blocks` is `JSON.stringify`d HERE rather than by the caller, because
   * `request()` form-encodes through `String(v)`: an array that reached it
   * unserialised would go out as the literal `[object Object]`.
   *
   * Which content fields may be combined is NOT decided here — see
   * `resolveMessageBody` in `helpers.ts`, which refuses the conflicting
   * combinations before anything is written.
   */
  async chatPostMessage(
    channel: string, text: string | undefined, threadTs?: string, options?: SlackPostOptions,
  ): Promise<{
    ts: string; channel: string; message?: SlackPostedMessage;
  }> {
    return this.request('chat.postMessage', {
      channel,
      // Left out of the body entirely when absent, not sent as an empty
      // string: a `markdown_text` call carrying a blank `text` is still a
      // `markdown_text_conflict` as far as Slack is concerned. `request()`
      // drops undefined anyway, but see the note above about not depending on
      // a filter several hundred lines away.
      ...(text !== undefined ? { text } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(options?.blocks ? { blocks: JSON.stringify(options.blocks) } : {}),
      ...(options?.markdownText !== undefined ? { markdown_text: options.markdownText } : {}),
      ...(options?.broadcast !== undefined ? { reply_broadcast: options.broadcast } : {}),
      ...(options?.unfurlLinks !== undefined ? { unfurl_links: options.unfurlLinks } : {}),
      ...(options?.unfurlMedia !== undefined ? { unfurl_media: options.unfurlMedia } : {}),
    });
  }

  /**
   * Edit an existing message in place. Authorized by `chat:write`, the same
   * scope as posting — but *whose* messages can be edited depends on the token:
   * a user token edits that user's own messages, a bot token only the bot's.
   * Slack enforces that itself and answers `cant_update_message`; see
   * `handleEditMessage` for the mapping of that and the other refusals.
   *
   * Takes the same content fields as `chatPostMessage` minus `broadcast`, so a
   * message posted as plain text can be converted into one with real list
   * elements after the fact. Note the asymmetry in Slack's replacement rule,
   * spelled out at the call below: omitting `blocks` while providing `text`
   * REMOVES any blocks the message already had.
   */
  async chatUpdate(
    channel: string, ts: string, text: string | undefined, options?: SlackUpdateOptions,
  ): Promise<{
    ts: string; channel: string; text?: string; message?: SlackPostedMessage;
  }> {
    return this.request('chat.update', {
      channel,
      ts,
      // Slack's replacement rule for this call is worth stating where it is
      // sent: "if the `text` argument is provided and `blocks` are not
      // provided, the `blocks` will be removed". So a text-only edit of a
      // message that currently has blocks STRIPS them. That is Slack's
      // behaviour, not something this layer can soften — `handleEditMessage`
      // and the tool description say so.
      ...(text !== undefined ? { text } : {}),
      ...(options?.blocks ? { blocks: JSON.stringify(options.blocks) } : {}),
      ...(options?.markdownText !== undefined ? { markdown_text: options.markdownText } : {}),
    });
  }

  // === Users ===

  async usersInfo(userId: string): Promise<{
    user: { id: string; name: string; real_name: string; is_bot?: boolean; is_app_user?: boolean; team_id?: string; profile?: { display_name?: string; image_48?: string } };
  }> {
    return this.request('users.info', { user: userId });
  }

  // === Team ===

  async teamInfo(teamId?: string): Promise<{
    team: { id: string; name: string; domain: string };
  }> {
    return this.request('team.info', teamId ? { team: teamId } : undefined);
  }

  // === Conversations (extended) ===

  async conversationsInfo(channel: string): Promise<{
    channel: SlackChannelTeamFields & {
      id: string; name: string; is_private: boolean;
      is_shared: boolean; is_ext_shared: boolean; is_org_shared: boolean;
      is_pending_ext_shared?: boolean;
      is_im: boolean; is_mpim: boolean;
      /**
       * Whether this installation is in the channel. Slack does not deliver
       * message events for channels it isn't in, so debugChannelEventSubscription
       * reads this to explain an event store that stays empty.
       */
      is_member?: boolean;
      user?: string;
      topic?: { value: string }; purpose?: { value: string };
      num_members?: number;
    };
  }> {
    return this.request('conversations.info', { channel });
  }

  async conversationsMembers(channel: string, cursor?: string): Promise<{
    members: string[];
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('conversations.members', {
      channel,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
  }

  // === Conversations (open DM) ===

  async conversationsOpen(userId: string): Promise<{
    channel: { id: string };
  }> {
    return this.request('conversations.open', { users: userId });
  }

  // === Files ===

  /** Metadata for one file, including every channel/DM it was shared into. */
  async filesInfo(fileId: string): Promise<{ file: SlackFileInfo }> {
    return this.request('files.info', { file: fileId });
  }

  /**
   * Download a Slack-hosted file's bytes. Kept as a thin delegate so the token
   * stays private to this class and never has to be threaded through callers.
   */
  async downloadFileBytes(url: string, opts?: { maxBytes?: number }): Promise<SlackFileBytes> {
    return fetchSlackFileBytes(url, this.botToken, opts);
  }

  // === Search ===

  /**
   * Full-text message search. USER TOKEN ONLY — bot tokens cannot call
   * search.*, so this is reachable from the slack-user server alone.
   *
   * Slack documents search.* as GET, but the endpoint accepts the same
   * form-urlencoded POST every other method here uses, so `request()` needs
   * no special casing.
   */
  async searchMessages(query: string, options?: SlackSearchOptions): Promise<{
    query: string;
    messages: SlackSearchPage<SlackMessageMatch>;
  }> {
    return this.request('search.messages', buildSearchBody(query, options));
  }

  /** Same call shape as searchMessages, over files instead of messages. */
  async searchFiles(query: string, options?: SlackSearchOptions): Promise<{
    query: string;
    files: SlackSearchPage<SlackFileMatch>;
  }> {
    return this.request('search.files', buildSearchBody(query, options));
  }

  // === Users (list) ===

  async usersList(cursor?: string, limit?: number): Promise<{
    members: Array<{
      id: string; name: string; real_name: string;
      team_id: string; is_bot: boolean;
      deleted?: boolean;
      profile?: { display_name?: string; image_48?: string };
    }>;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('users.list', {
      limit: limit ?? 200,
      ...(cursor ? { cursor } : {}),
    });
  }
}
