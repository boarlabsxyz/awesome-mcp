// src/__tests__/supabase/restOps.test.ts
// The REST plane's pieces that need no web server: the route table's
// invariants against the registered tools and the catalog, the response
// envelope, and the failure → status mapping. The route-level behaviour (auth,
// settings with real connections) is in src/__tests__/restRoutes.supabase.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';

import { REST_CATALOG } from '../../restCatalog.js';
import { SupabaseSettingsUnavailable } from '../../supabase/apiHelpers.js';
import { MAX_RESULT_CHARS, SupabaseCallError } from '../../supabase/hostedProxy.js';
import { handleSupabaseRest, supabaseRestBody, supabaseRestError } from '../../supabase/restOps.js';
import { SUPABASE_REST_ROUTES } from '../../supabase/restRoutes.js';
import { SUPABASE_TOOLS } from '../../supabase/server.js';
import { SupabaseSettingDenied } from '../../supabase/settings.js';

describe('supabase REST route table', () => {
  it('names only registered tools, GET only for read-only ones, and no destructive tool', () => {
    for (const route of SUPABASE_REST_ROUTES) {
      const def = SUPABASE_TOOLS.find(t => t.name === route.tool);
      assert.ok(def, `${route.tool} is not a registered Supabase tool`);
      assert.notEqual(def!.annotations.destructiveHint, true, `${route.tool} is destructive and must stay MCP-only`);
      if (route.method === 'get') assert.equal(def!.annotations.readOnlyHint, true, `${route.tool} is served over GET but writes`);
    }
  });

  it('matches the catalog one to one: every live supabase entry has a route and vice versa', () => {
    const toCatalog = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');
    const routes = SUPABASE_REST_ROUTES.map(r => `${r.method.toUpperCase()} ${toCatalog(r.path)} ${r.tool}`).sort();
    const catalog = REST_CATALOG
      .filter(e => e.service === 'supabase' && e.status === 'live')
      .map(e => `${e.method} ${e.path.split('?')[0]} ${e.mcpToolName}`)
      .sort();
    assert.deepEqual(routes, catalog);
  });

  it('answers 201 exactly where a resource is created', () => {
    const created = SUPABASE_REST_ROUTES.filter(r => r.status === 201).map(r => r.tool).sort();
    assert.deepEqual(created, ['create_branch', 'create_notebook', 'create_project', 'submit_feedback']);
  });
});

describe('supabaseRestBody', () => {
  it('parses a JSON answer and keeps a non-JSON one as text', () => {
    assert.deepEqual(supabaseRestBody('list_projects', '[1,2]'), { tool: 'list_projects', truncated: false, untrustedData: false, result: [1, 2] });
    assert.deepEqual(supabaseRestBody('get_project_url', 'https://x.supabase.co'), {
      tool: 'get_project_url', truncated: false, untrustedData: false, result: 'https://x.supabase.co',
    });
  });

  it('cuts at the MCP cap, reports how much there was, and keeps the untrusted flag', () => {
    // A metadata tool, so the flag can only come from the boundary marker.
    const text = `<untrusted-data-a>${'y'.repeat(MAX_RESULT_CHARS)}`;
    const body = supabaseRestBody('list_projects', text);
    assert.equal(body.truncated, true);
    assert.equal(body.totalChars, text.length);
    assert.equal((body.result as string).length, MAX_RESULT_CHARS);
    assert.equal(body.untrustedData, true);
  });
});

describe('untrustedData', () => {
  // Free text other people wrote or can influence, which upstream does not
  // wrap in its boundary: flagged by tool, whatever the text looks like.
  const OUTSIDER_TEXT = [
    'get_notebook', 'list_notebooks', 'get_logs', 'query_logs', 'get_edge_function',
    'list_migrations', 'get_advisors', 'list_tables', 'generate_typescript_types',
  ];

  it('is true for every tool returning outsider-written text, even as plain JSON', () => {
    for (const tool of OUTSIDER_TEXT) {
      assert.ok(SUPABASE_REST_ROUTES.some(r => r.tool === tool), `${tool} has no route`);
      assert.equal(supabaseRestBody(tool, '{"rows":[]}').untrustedData, true, tool);
    }
  });

  it('is false for every other routed tool unless the boundary marker is present', () => {
    for (const route of SUPABASE_REST_ROUTES.filter(r => !OUTSIDER_TEXT.includes(r.tool))) {
      assert.equal(supabaseRestBody(route.tool, '{"id":"x"}').untrustedData, false, route.tool);
      assert.equal(supabaseRestBody(route.tool, '<untrusted-data-1>x</untrusted-data-1>').untrustedData, true, route.tool);
    }
  });
});

describe('supabaseRestError', () => {
  const map = (err: unknown) => supabaseRestError(err, 'Failed to x');

  it('maps a settings refusal to 403 naming the setting', () => {
    assert.deepEqual(map(new SupabaseSettingDenied('readOnly', 'ro')), { status: 403, body: { error: 'ro', setting: 'readOnly' } });
  });

  it('maps an unreadable settings store to 503', () => {
    assert.equal(map(new SupabaseSettingsUnavailable('cannot read')).status, 503);
  });

  it('maps the upstream outcomes', () => {
    assert.equal(map(new SupabaseCallError('tool_error', 'no')).status, 422);
    assert.deepEqual(map(new SupabaseCallError('input_required', 'ask')), { status: 409, body: { error: 'ask', performed: false } });
    assert.equal(map(new SupabaseCallError('transport', 'forbidden', 403)).status, 403);
    assert.equal(map(new SupabaseCallError('transport', 'slow down', 429)).status, 429);
    // A 401 is never echoed, not even in the body: it would read as the caller's bearer.
    assert.deepEqual(map(new SupabaseCallError('transport', 'bad token', 401)), { status: 502, body: { error: 'bad token' } });
    assert.deepEqual(map(new SupabaseCallError('transport', 'down', 503)), { status: 502, body: { error: 'down', upstreamStatus: 503 } });
    assert.deepEqual(map(new SupabaseCallError('transport', 'timed out')), { status: 502, body: { error: 'timed out' } });
  });

  it('maps a plain UserError to 400 and anything else to a 500 with the fallback', () => {
    assert.deepEqual(map(new UserError('Supabase not connected')), { status: 400, body: { error: 'Supabase not connected' } });
    assert.deepEqual(map(new Error('boom')), { status: 500, body: { error: 'Failed to x' } });
    assert.deepEqual(map(undefined), { status: 500, body: { error: 'Failed to x' } });
  });
});

describe('handleSupabaseRest', () => {
  const route = SUPABASE_REST_ROUTES.find(r => r.tool === 'list_projects')!;
  const req = { params: {}, query: {}, body: undefined };

  it('answers 403 when the session carries no Supabase token', async () => {
    const out = await handleSupabaseRest(route, req, {} as any, 'json');
    assert.equal(out.status, 403);
  });

  it('answers 500 naming the tool when it is not registered (a bug, not the caller)', async () => {
    const out = await handleSupabaseRest(route, req, { supabaseAccessToken: 'sbp_x' } as any, 'json', async () => []);
    assert.equal(out.status, 500);
    assert.match(String((out.body as any).error), /list_projects is not registered/);
  });

  it('fails closed with 503 when the connection behind the session is gone', async () => {
    const out = await handleSupabaseRest(route, req, { supabaseAccessToken: 'sbp_x', supabaseInstanceId: 'no-such-instance' } as any, 'json');
    assert.equal(out.status, 503);
    assert.match(String((out.body as any).error), /nothing was run/);
  });
});
