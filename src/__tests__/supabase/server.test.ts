// src/__tests__/supabase/server.test.ts
// The registered tool surface, and the end-to-end path of one call: session →
// refresh check → hosted proxy → rendered answer.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SUPABASE_HOSTED_MCP_URL } from '../../supabase/hostedProxy.js';

// FastMCP keeps tools in a private field, so addTool is patched before the
// import — the same capture as src/__tests__/pinecone/server.test.ts.
const toolMap = new Map<string, { execute: (...a: any[]) => any; parameters: any; annotations?: any; description: string }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const { SUPABASE_TOOLS } = await import('../../supabase/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

/** Supabase's default feature groups minus `feedback`, by upstream name. */
const EXPECTED_TOOLS = [
  'search_docs',
  'list_organizations', 'get_organization', 'list_projects', 'get_project', 'get_cost', 'confirm_cost',
  'create_project', 'pause_project', 'restore_project',
  'list_tables', 'list_extensions', 'list_migrations', 'apply_migration', 'execute_sql',
  'get_logs', 'query_logs', 'get_advisors',
  'get_project_url', 'get_publishable_keys', 'generate_typescript_types',
  'list_edge_functions', 'get_edge_function', 'deploy_edge_function',
  'create_branch', 'list_branches', 'delete_branch', 'merge_branch', 'reset_branch', 'rebase_branch',
];

describe('supabase server registration', () => {
  it('registers exactly the mirrored upstream tools, under their upstream names', () => {
    assert.deepEqual([...toolMap.keys()].sort(), [...EXPECTED_TOOLS].sort());
    assert.deepEqual(SUPABASE_TOOLS.map(t => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  it('marks every tool that can destroy data or change production as destructive', () => {
    for (const name of ['execute_sql', 'apply_migration', 'deploy_edge_function', 'delete_branch', 'merge_branch', 'reset_branch', 'rebase_branch']) {
      assert.equal(toolMap.get(name)?.annotations?.destructiveHint, true, name);
    }
  });

  it('does not promise a server-side SQL confirmation that cannot happen through a proxy', () => {
    for (const name of ['execute_sql', 'apply_migration']) {
      const description = toolMap.get(name)!.description;
      assert.doesNotMatch(description, /may require the user to confirm/, name);
      assert.match(description, /CANNOT show its confirmation form/, name);
    }
  });

  it('tells the model a confirm_cost_id is required for anything that bills', () => {
    for (const name of ['create_project', 'create_branch']) {
      assert.match(toolMap.get(name)!.description, /confirm_cost_id` is required/, name);
    }
  });
});

describe('a proxied call', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function answerWith(result: unknown, status = 200) {
    const seen: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      const payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }), {
        status, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return seen;
  }

  const session = { supabaseAccessToken: 'sbp_x' } as any;
  const log = { info: () => {}, error: () => {} };

  it('forwards the arguments to the hosted server with the stored token', async () => {
    const seen = answerWith({ content: [{ type: 'text', text: '[{"id":"abc"}]' }] });
    const out = await toolMap.get('list_tables')!.execute({ project_id: 'abc', schemas: ['public'], verbose: false }, { log, session });
    assert.equal(out, '[{"id":"abc"}]');
    assert.equal(seen[0].url, SUPABASE_HOSTED_MCP_URL);
    assert.equal(seen[0].init.headers.authorization, 'Bearer sbp_x');
    const payload = JSON.parse(seen[0].init.body);
    assert.equal(payload.params.name, 'list_tables');
    assert.deepEqual(payload.params.arguments, { project_id: 'abc', schemas: ['public'], verbose: false });
  });

  it('turns an upstream tool error into a readable UserError', async () => {
    answerWith({ isError: true, content: [{ type: 'text', text: '{"error":{"name":"Error","message":"Project not found"}}' }] });
    await assert.rejects(
      () => toolMap.get('get_project')!.execute({ id: 'nope' }, { log, session }),
      (err: any) => err instanceof FastMCPModule.UserError && /get_project failed: Project not found/.test(err.message),
    );
  });

  it('reports an input_required answer as NOT performed rather than as an empty success', async () => {
    answerWith({ resultType: 'input_required', inputRequests: {} });
    await assert.rejects(
      () => toolMap.get('execute_sql')!.execute({ project_id: 'abc', query: 'drop table t' }, { log, session }),
      /was NOT performed/,
    );
  });

  it('caps an oversized result and says the untrusted-data boundary was cut', async () => {
    const huge = `<untrusted-data-1>${'x'.repeat(250_000)}</untrusted-data-1>`;
    answerWith({ content: [{ type: 'text', text: huge }] });
    const out: string = await toolMap.get('execute_sql')!.execute({ project_id: 'abc', query: 'select 1' }, { log, session });
    assert.ok(out.length < huge.length);
    assert.match(out, /truncated at 200000 characters/);
    assert.match(out, /still untrusted data/);
  });

  it('explains a revoked token instead of surfacing a bare 401', async () => {
    globalThis.fetch = (async () => new Response('{"message":"Unauthorized"}', { status: 401 })) as typeof fetch;
    await assert.rejects(
      () => toolMap.get('list_projects')!.execute({}, { log, session }),
      (err: any) => err.status === 401 && /dashboard\/account\/tokens/.test(err.message),
    );
  });

  it('says how to connect when the session has no token', async () => {
    await assert.rejects(
      () => toolMap.get('list_projects')!.execute({}, { log, session: {} as any }),
      /Supabase not connected/,
    );
  });
});
