import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

import { argsForSettings, hostedUrlFor, normalizeSupabaseSettings, SUPABASE_FEATURE_GROUPS } from '../../supabase/settings.js';
import { createWebOnlyApp } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import {
  createMcpInstance, getMcpConnectionByInstanceId, GoogleTokens, patchMcpInstanceProviderTokens, updateMcpInstanceProviderTokens,
} from '../../mcpConnectionStore.js';
import { createMcpCatalog } from '../../mcpCatalogStore.js';
import { maybeRefreshSupabaseToken, runSupabaseTool } from '../../supabase/apiHelpers.js';
import { mergeProviderReconnectTokens } from '../../website/webServer.js';

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true };

describe('Supabase settings', () => {
  it('builds the hosted URL on the fixed origin, always naming the feature groups', () => {
    const plain = new URL(hostedUrlFor('https://mcp.supabase.com/mcp'));
    assert.equal(plain.origin + plain.pathname, 'https://mcp.supabase.com/mcp');
    assert.equal(plain.searchParams.get('features'), SUPABASE_FEATURE_GROUPS.join(','));
    assert.equal(plain.searchParams.get('read_only'), null);

    const scoped = new URL(hostedUrlFor('https://mcp.supabase.com/mcp', { projectRef: 'abcdefghijklmnopqrst', readOnly: true, features: ['database', 'docs'] }));
    assert.equal(scoped.searchParams.get('project_ref'), 'abcdefghijklmnopqrst');
    assert.equal(scoped.searchParams.get('read_only'), 'true');
    assert.equal(scoped.searchParams.get('features'), 'database,docs');
  });

  it('validates what the dashboard posts, and stores "everything on" as absent', () => {
    assert.deepEqual(normalizeSupabaseSettings({ projectRef: '', readOnly: false, features: [...SUPABASE_FEATURE_GROUPS] }), { settings: {} });
    assert.deepEqual(normalizeSupabaseSettings({ projectRef: 'abcdefghijklmnopqrst', readOnly: true, features: ['database'] }),
      { settings: { projectRef: 'abcdefghijklmnopqrst', readOnly: true, features: ['database'] } });
    assert.match((normalizeSupabaseSettings({ projectRef: 'https://evil.example/x' }) as any).error, /project ref/);
    assert.match((normalizeSupabaseSettings({ features: ['database', 'nope'] }) as any).error, /Unknown feature group/);
    assert.match((normalizeSupabaseSettings({ features: [] }) as any).error, /at least one/);
    assert.match((normalizeSupabaseSettings({ readOnly: 'yes' }) as any).error, /true or false/);
  });

  it('refuses locally what the settings rule out, naming the setting', () => {
    assert.throws(() => argsForSettings({ name: 'list_notebooks', group: 'notebooks', annotations: READ }, {}, { features: ['database'] }), /notebooks feature group/);
    assert.throws(() => argsForSettings({ name: 'list_projects', group: 'account', annotations: READ }, {}, { projectRef: 'abcdefghijklmnopqrst' }), /account tool/);
    assert.throws(() => argsForSettings({ name: 'apply_migration', group: 'database', annotations: WRITE }, {}, { readOnly: true }), /read-only/);
    // Supabase runs these read-only instead of refusing them, so they stay.
    assert.doesNotThrow(() => argsForSettings({ name: 'execute_sql', group: 'database', annotations: WRITE }, { query: 'select 1' }, { readOnly: true }));
  });

  it('with a project limit, drops the matching project_id and refuses another one', () => {
    const def = { name: 'list_tables', group: 'database' as const, annotations: READ };
    const settings = { projectRef: 'abcdefghijklmnopqrst' };
    assert.deepEqual(argsForSettings(def, { project_id: 'abcdefghijklmnopqrst', schemas: ['public'] }, settings), { schemas: ['public'] });
    assert.throws(() => argsForSettings(def, { project_id: 'zzzzzzzzzzzzzzzzzzzz' }, settings), /different project.*Nothing was run/);
    assert.deepEqual(argsForSettings(def, { project_id: 'p', schemas: [] }, {}), { project_id: 'p', schemas: [] });
  });
});

// --- dashboard routes ---

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const signCookie = (val: string) => `s:${val}.${crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '')}`;
const OWNER_ID = 9401;
const STRANGER_ID = 9402;
const dummyTokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const emptyGoogleTokens: GoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

describe('Supabase settings dashboard routes', () => {
  const app = createWebOnlyApp();
  let cookie: string;
  let mine: string;
  let theirs: string;

  before(async () => {
    if (!process.env.GOOGLE_CREDENTIALS) {
      process.env.GOOGLE_CREDENTIALS = JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] } });
    }
    await createMcpCatalog({
      slug: 'supabase', name: 'Supabase MCP', description: 'test', iconUrl: '', mcpUrl: '/supabase', provider: 'supabase', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [], isLocal: true, isActive: true,
    });
    await createOrUpdateUser({ email: 'sb-settings@example.com', googleId: 'google-sb-settings', name: 'SB' }, dummyTokens);
    const user = await getUserByGoogleId('google-sb-settings');
    if (user) (user as any).id = OWNER_ID;
    mine = (await createMcpInstance(OWNER_ID, 'supabase', 'Mine', emptyGoogleTokens, null, 'supabase', { access_token: 'sbp_mine' } as any, null)).instanceId;
    theirs = (await createMcpInstance(STRANGER_ID, 'supabase', 'Theirs', emptyGoogleTokens, null, 'supabase', { access_token: 'sbp_theirs' } as any, null)).instanceId;
    cookie = `session=${signCookie(await createSession('google-sb-settings'))}`;
  });

  const stored = async (id: string) => (await getMcpConnectionByInstanceId(id))?.providerTokens as any;

  it('reports the defaults before anything is set', async () => {
    const res = await request(app).get(`/api/instances/${mine}/supabase-settings`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.settings, { projectRef: '', readOnly: false, features: [...SUPABASE_FEATURE_GROUPS] });
  });

  it('saves settings without dropping the token, and clears them by deleting the key', async () => {
    const res = await request(app).post(`/api/instances/${mine}/supabase-settings`).set('Cookie', cookie)
      .send({ settings: { projectRef: 'abcdefghijklmnopqrst', readOnly: true, features: ['database', 'docs'] } });
    assert.equal(res.status, 200);
    let tokens = await stored(mine);
    assert.equal(tokens.access_token, 'sbp_mine');
    assert.deepEqual(tokens.supabaseSettings, { projectRef: 'abcdefghijklmnopqrst', readOnly: true, features: ['database', 'docs'] });

    await request(app).post(`/api/instances/${mine}/supabase-settings`).set('Cookie', cookie)
      .send({ settings: { projectRef: '', readOnly: false, features: [...SUPABASE_FEATURE_GROUPS] } }).expect(200);
    tokens = await stored(mine);
    assert.equal('supabaseSettings' in tokens, false);
    assert.equal(tokens.access_token, 'sbp_mine');
  });

  it('answers 400 for invalid settings and 404 for someone else\'s connection', async () => {
    const bad = await request(app).post(`/api/instances/${mine}/supabase-settings`).set('Cookie', cookie).send({ settings: { features: ['nope'] } });
    assert.equal(bad.status, 400);
    const other = await request(app).get(`/api/instances/${theirs}/supabase-settings`).set('Cookie', cookie);
    assert.equal(other.status, 404);
  });
});

describe('a call through a connection with settings', () => {
  const realFetch = globalThis.fetch;
  const log = { info: () => {}, error: () => {} };
  const LIST_TABLES = { name: 'list_tables', group: 'database' as const, annotations: READ };
  let instanceId: string;
  let seen: Array<{ url: string; body: any }>;

  before(async () => {
    instanceId = (await createMcpInstance(OWNER_ID, 'supabase', 'Limited', emptyGoogleTokens, null, 'supabase', {
      access_token: 'sbp_limited', supabaseSettings: { projectRef: 'abcdefghijklmnopqrst', readOnly: true },
    } as any, null)).instanceId;
  });
  const answer = () => {
    seen = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(url), body });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  };
  after(() => { globalThis.fetch = realFetch; });

  it('sends the settings as URL options and drops the injected project_id', async () => {
    answer();
    const session = { supabaseAccessToken: 'sbp_limited', supabaseInstanceId: instanceId } as any;
    assert.equal(await runSupabaseTool(LIST_TABLES, { project_id: 'abcdefghijklmnopqrst', schemas: ['public'] }, session, log), 'ok');
    const url = new URL(seen[0].url);
    assert.equal(url.searchParams.get('project_ref'), 'abcdefghijklmnopqrst');
    assert.equal(url.searchParams.get('read_only'), 'true');
    assert.deepEqual(seen[0].body.params.arguments, { schemas: ['public'] });
  });

  it('refuses a write, an account tool and a branch-id tool without calling Supabase', async () => {
    answer();
    const session = { supabaseAccessToken: 'sbp_limited', supabaseInstanceId: instanceId } as any;
    await assert.rejects(() => runSupabaseTool({ name: 'apply_migration', group: 'database', annotations: WRITE }, {}, session, log), /read-only/);
    await assert.rejects(() => runSupabaseTool({ name: 'list_projects', group: 'account', annotations: READ }, {}, session, log), /account tool/);
    await assert.rejects(() => runSupabaseTool({ name: 'merge_branch', group: 'branching', annotations: WRITE }, { branch_id: 'b' }, session, log), /branch by its ID/);
    assert.equal(seen.length, 0);
  });

  it('fails closed when the connection is gone', async () => {
    answer();
    const session = { supabaseAccessToken: 'sbp_limited', supabaseInstanceId: 'no-such-instance' } as any;
    await assert.rejects(() => runSupabaseTool(LIST_TABLES, { project_id: 'x' }, session, log), /nothing was run/);
    assert.equal(seen.length, 0);
  });

  it('keeps the settings across an OAuth reconnect', () => {
    const merged = mergeProviderReconnectTokens({ access_token: 'new' } as Record<string, any>, {
      access_token: 'old', supabaseSettings: { readOnly: true },
    });
    assert.deepEqual((merged as any).supabaseSettings, { readOnly: true });
  });
});

// The settings save, the call-time refresh and a reconnect all write the one
// provider_tokens value. Each must change only its own keys, or a refresh that
// read before a "read-only" save puts the unrestricted settings back. These run
// on the file store; the Postgres statements do the same inside one UPDATE.
describe('provider_tokens writers keep each other\'s keys', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });
  const LIMITED = { projectRef: 'abcdefghijklmnopqrst', readOnly: true };
  const fresh = async (tokens: Record<string, unknown>) =>
    (await createMcpInstance(OWNER_ID, 'supabase', 'Writers', emptyGoogleTokens, null, 'supabase', tokens as any, null)).instanceId;
  const stored = async (id: string) => (await getMcpConnectionByInstanceId(id))?.providerTokens as any;

  it('patch sets and deletes only the keys it names', async () => {
    const id = await fresh({ access_token: 'a', expiry_date: 1, supabaseSettings: LIMITED });
    await patchMcpInstanceProviderTokens(id, { access_token: 'b', expiry_date: undefined });
    assert.deepEqual(await stored(id), { access_token: 'b', supabaseSettings: LIMITED });
  });

  it('a refresh stores the new token without touching the settings', async () => {
    const id = await fresh({ access_token: 'old', refresh_token: 'rt', supabaseSettings: LIMITED });
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await maybeRefreshSupabaseToken({
      supabaseAccessToken: 'old', supabaseRefreshToken: 'rt', supabaseTokenExpiry: Date.now() - 1_000,
      supabaseOauthClientId: 'id', supabaseOauthClientSecret: 'sec', supabaseInstanceId: id,
    } as any, { info: () => {}, error: () => {} });
    const tokens = await stored(id);
    assert.equal(tokens.access_token, 'new');
    assert.equal(tokens.refresh_token, 'rt2');
    assert.deepEqual(tokens.supabaseSettings, LIMITED);
  });

  it('a reconnect keeps the settings as stored at write time, not as the caller last read them', async () => {
    const id = await fresh({ access_token: 'old', refresh_token: 'rt' });
    // Saved after the reconnect read the record: it never saw these settings.
    await patchMcpInstanceProviderTokens(id, { supabaseSettings: LIMITED });
    await updateMcpInstanceProviderTokens(id, { access_token: 'new', refresh_token: '' } as any, {
      keepIfAbsent: ['refresh_token', 'supabaseSettings'],
    });
    assert.deepEqual(await stored(id), { access_token: 'new', refresh_token: 'rt', supabaseSettings: LIMITED });
  });

  it('a reconnect that supplies a preserved key replaces it, and drops everything unlisted', async () => {
    const id = await fresh({ access_token: 'old', stale: true, supabaseSettings: LIMITED });
    await updateMcpInstanceProviderTokens(id, { access_token: 'new', supabaseSettings: { readOnly: true } } as any, {
      keepIfAbsent: ['supabaseSettings'],
    });
    assert.deepEqual(await stored(id), { access_token: 'new', supabaseSettings: { readOnly: true } });
  });
});
