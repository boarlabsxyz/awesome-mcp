import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

import { argsForSettings, hostedUrlFor, normalizeSupabaseSettings, SUPABASE_FEATURE_GROUPS } from '../../supabase/settings.js';
import { createWebOnlyApp } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import { createMcpInstance, getMcpConnectionByInstanceId, GoogleTokens } from '../../mcpConnectionStore.js';
import { createMcpCatalog } from '../../mcpCatalogStore.js';

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
    assert.throws(() => argsForSettings(def, { project_id: 'zzzzzzzzzzzzzzzzzzzz' }, settings), /different project. Nothing was run/);
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
  after(() => {});

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
