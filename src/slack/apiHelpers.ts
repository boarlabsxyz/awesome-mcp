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
        throw new UserError(`Slack API error (${method}): ${retryData.error || 'unknown error'}`);
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
      throw new UserError(`Slack API error (${method}): ${data.error || 'unknown error'}`);
    }

    return data as T;
  }

  // === Auth ===

  async authTest(): Promise<{ ok: boolean; user_id: string; team: string; team_id: string; bot_id?: string; url: string }> {
    return this.request('auth.test');
  }

  // === Conversations ===

  async conversationsList(cursor?: string, types?: string): Promise<{
    channels: Array<{
      id: string; name: string; is_private: boolean; is_archived: boolean;
      is_ext_shared?: boolean; is_org_shared?: boolean; is_im?: boolean; is_mpim?: boolean;
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
    channels: Array<{
      id: string; name: string; is_private: boolean; is_archived: boolean;
      is_ext_shared?: boolean; is_org_shared?: boolean; is_im?: boolean; is_mpim?: boolean;
      user?: string;
      topic?: { value: string }; purpose?: { value: string }; num_members?: number;
    }>;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.request('conversations.list', {
      types: types || 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
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

  async chatPostMessage(channel: string, text: string, threadTs?: string): Promise<{
    ts: string; channel: string;
  }> {
    return this.request('chat.postMessage', {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
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
    channel: {
      id: string; name: string; is_private: boolean;
      is_shared: boolean; is_ext_shared: boolean; is_org_shared: boolean;
      is_im: boolean; is_mpim: boolean;
      /**
       * Whether this installation is in the channel. Slack does not deliver
       * message events for channels it isn't in, so debugChannelEventSubscription
       * reads this to explain an event store that stays empty.
       */
      is_member?: boolean;
      user?: string;
      shared_team_ids?: string[];
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
