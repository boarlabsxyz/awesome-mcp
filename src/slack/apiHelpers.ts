// src/slack/apiHelpers.ts
import { UserError } from 'fastmcp';

const SLACK_API_BASE = 'https://slack.com/api';

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
      const retryAfter = res.headers.get('Retry-After');
      throw new UserError(`Slack rate limit exceeded. Try again${retryAfter ? ` in ${retryAfter}s` : ' in a moment'}.`);
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

  async conversationsList(cursor?: string): Promise<{
    channels: Array<{
      id: string; name: string; is_private: boolean; is_archived: boolean;
      is_ext_shared?: boolean; is_org_shared?: boolean;
      topic?: { value: string }; purpose?: { value: string }; num_members?: number;
    }>;
    response_metadata?: { next_cursor?: string };
  }> {
    // users.conversations returns only channels the bot is a member of,
    // unlike conversations.list which returns all visible channels.
    return this.request('users.conversations', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
  }

  async conversationsHistory(channel: string, options?: {
    limit?: number; oldest?: string; latest?: string; cursor?: string;
  }): Promise<{
    messages: Array<{ type: string; user?: string; text: string; ts: string; thread_ts?: string; reply_count?: number }>;
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
    messages: Array<{ type: string; user?: string; text: string; ts: string; thread_ts?: string }>;
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
    user: { id: string; name: string; real_name: string; profile?: { display_name?: string } };
  }> {
    return this.request('users.info', { user: userId });
  }
}
