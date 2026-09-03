// Direct Slack Web API client for e2e setup/teardown — independent of the MCP.
//
// Two identities, because src/ ships two Slack servers with the same tool
// surface but different auth:
//   - `slack`       (src/slack/, catalog slug `slack-bot`) — bot token, xoxb-
//   - `slack-user`  (src/slack-user/, catalog slug `slack`) — user token, xoxp-
// Each gets its own env var so teardown runs as the SAME identity that the
// connector posted with. Slack's chat.delete only lets a token delete its own
// messages, so a mismatched token means every write test leaks a message.
//
// Mirrors src/slack/apiHelpers.ts's transport choice: form-urlencoded, not
// JSON — several Slack methods reject JSON bodies.

import { required } from './scratchNaming.ts';

const SLACK_API_BASE = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 30_000;
const DOC = 'e2e/fixtures/write-slack.md';

/** Keyed by src/ directory name, matching ServiceName in tools/index.ts. */
export type SlackService = 'slack' | 'slack-user';

const TOKEN_ENV: Record<SlackService, string> = {
  'slack': 'E2E_SLACK_BOT_TOKEN',
  'slack-user': 'E2E_SLACK_USER_TOKEN',
};

export interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackE2EClient {
  constructor(private readonly token: string) {}

  async call<T extends SlackResponse = SlackResponse>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const form = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');

    let res: Response;
    try {
      res = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`[e2e] Slack request timed out: ${method}`);
      }
      throw new Error(`[e2e] Slack request failed (${method}): ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`[e2e] Slack ${method} -> HTTP ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as T;
    if (!body.ok) throw new Error(`[e2e] Slack ${method} -> ${body.error ?? 'unknown error'}`);
    return body;
  }
}

const cache = new Map<SlackService, SlackE2EClient>();

export function getSlackWriteClient(service: SlackService): SlackE2EClient {
  let client = cache.get(service);
  if (!client) {
    client = new SlackE2EClient(required(TOKEN_ENV[service], DOC));
    cache.set(service, client);
  }
  return client;
}
