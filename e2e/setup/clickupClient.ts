// Direct ClickUp API client for e2e setup/teardown — independent of the MCP.
//
// Same role as setup/googleClient.ts on the Google side: write tests need to
// create and destroy scratch tasks/lists without going through the tool under
// test. Deliberately a thin fetch wrapper rather than an import of
// src/clickup/apiHelpers.ts — that module throws fastmcp `UserError`s and is
// part of the system under test, so the harness keeps its own copy of the two
// dozen lines it actually needs.
//
// Auth: a personal API token (`pk_...`) or an OAuth access token for the write
// workspace, in E2E_CLICKUP_API_TOKEN. It must be the same identity bound to
// the awesome-mcp-clickup-full connector, otherwise teardown can't delete what
// the MCP created.

import { required } from './scratchNaming.ts';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const DOC = 'e2e/fixtures/write-clickup.md';

export class ClickUpE2EClient {
  constructor(private readonly token: string) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${CLICKUP_API_BASE}${path}`, {
        method,
        headers: {
          // ClickUp accepts personal tokens raw and OAuth tokens with the
          // Bearer prefix; normalizing here keeps both kinds of secret working.
          Authorization: this.token.startsWith('pk_') ? this.token : `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`[e2e] ClickUp request timed out: ${method} ${path}`);
      }
      throw new Error(`[e2e] ClickUp request failed (${method} ${path}): ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `[e2e] ClickUp ${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      );
    }

    // DELETE endpoints return an empty body.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

let cached: ClickUpE2EClient | undefined;

export function getClickUpWriteClient(): ClickUpE2EClient {
  if (!cached) cached = new ClickUpE2EClient(required('E2E_CLICKUP_API_TOKEN', DOC));
  return cached;
}
