import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

import { hostedUrlFor, mergeBrowserbaseSettings, publicBrowserbaseSettings, BROWSERBASE_DEFAULT_MODEL } from '../../browserbase/settings.js';
import { redactSecrets } from '../../browserbase/responseSafety.js';
import { hostedProxyFor } from '../../browserbase/ops.js';
import { createWebOnlyApp, mergeProviderReconnectTokens } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import { createMcpInstance, getMcpConnectionByInstanceId, GoogleTokens } from '../../mcpConnectionStore.js';
import { createMcpCatalog } from '../../mcpCatalogStore.js';

const KEY = 'sk-test-0123456789abcdef';

describe('Browserbase settings', () => {
  it('a non-default model needs its key; the default model needs none and stores nothing', () => {
    assert.match((mergeBrowserbaseSettings(undefined, { modelName: 'openai/gpt-4.1' }) as any).error, /needs its provider's API key/);
    assert.deepEqual(mergeBrowserbaseSettings(undefined, { modelName: 'openai/gpt-4.1', modelApiKey: KEY }),
      { settings: { modelName: 'openai/gpt-4.1', modelApiKey: KEY } });
    assert.deepEqual(mergeBrowserbaseSettings(undefined, { modelName: BROWSERBASE_DEFAULT_MODEL, modelApiKey: KEY }), { settings: {} });
  });

  it('keeps the stored key when none is sent, and clears it on null', () => {
    const stored = { modelName: 'openai/gpt-4.1', modelApiKey: KEY };
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: 'openai/gpt-4.1', proxies: true }),
      { settings: { modelName: 'openai/gpt-4.1', modelApiKey: KEY, proxies: true } });
    assert.match((mergeBrowserbaseSettings(stored, { modelName: 'openai/gpt-4.1', modelApiKey: null }) as any).error, /needs its provider's API key/);
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: '', modelApiKey: null }), { settings: {} });
  });

  it('refuses malformed input', () => {
    assert.match((mergeBrowserbaseSettings(undefined, { modelName: 'https://evil/x', modelApiKey: KEY }) as any).error, /provider\/model/);
    assert.match((mergeBrowserbaseSettings(undefined, { modelName: 'openai/gpt-4.1', modelApiKey: 'has spaces in it' }) as any).error, /does not look like/);
    assert.match((mergeBrowserbaseSettings(undefined, { keepAlive: 'yes' }) as any).error, /true or false/);
  });

  it('never shows the key, only whether it is set', () => {
    const view = publicBrowserbaseSettings({ modelName: 'openai/gpt-4.1', modelApiKey: KEY });
    assert.equal(JSON.stringify(view).includes(KEY), false);
    assert.equal(view.modelApiKeySet, true);
  });

  it('builds the URL on the fixed origin with only the documented parameters', () => {
    const url = new URL(hostedUrlFor('https://mcp.browserbase.com/mcp', { modelName: 'openai/gpt-4.1', modelApiKey: KEY, keepAlive: true, verified: true }));
    assert.equal(url.origin + url.pathname, 'https://mcp.browserbase.com/mcp');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['keepAlive', 'modelApiKey', 'modelName', 'verified']);
    assert.equal(url.searchParams.get('keepAlive'), 'true');
    assert.equal(hostedUrlFor('https://mcp.browserbase.com/mcp', {}), 'https://mcp.browserbase.com/mcp');
  });

  it('redacts the model key if Browserbase ever echoes the URL', () => {
    const { text } = redactSecrets(`failed: https://mcp.browserbase.com/mcp?modelName=x&modelApiKey=${KEY}`);
    assert.equal(text.includes(KEY), false);
  });

  it('the proxy reads the settings per call and sends them upstream', async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      urls.push(String(url));
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }), {
        status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' },
      });
    }) as typeof fetch;
    try {
      await hostedProxyFor('bb_key', async () => ({ proxies: true }))('observe', { instruction: 'x', sessionId: 's1' }).catch(() => {});
      assert.ok(urls.length > 0);
      assert.ok(urls.every((u) => new URL(u).searchParams.get('proxies') === 'true'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('survives an OAuth-style reconnect merge', () => {
    const merged = mergeProviderReconnectTokens({ access_token: 'new' } as Record<string, any>, { access_token: 'old', browserbaseSettings: { proxies: true } });
    assert.deepEqual((merged as any).browserbaseSettings, { proxies: true });
  });
});

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const signCookie = (val: string) => `s:${val}.${crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '')}`;
const OWNER_ID = 9501;
const dummyTokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const emptyGoogleTokens: GoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

describe('Browserbase settings dashboard routes', () => {
  const app = createWebOnlyApp();
  let cookie: string;
  let id: string;

  before(async () => {
    if (!process.env.GOOGLE_CREDENTIALS) {
      process.env.GOOGLE_CREDENTIALS = JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] } });
    }
    await createMcpCatalog({
      slug: 'browserbase', name: 'Browserbase MCP', description: 'test', iconUrl: '', mcpUrl: '/browserbase', provider: 'browserbase', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [], isLocal: true, isActive: true,
    });
    await createOrUpdateUser({ email: 'bb-settings@example.com', googleId: 'google-bb-settings', name: 'BB' }, dummyTokens);
    const user = await getUserByGoogleId('google-bb-settings');
    if (user) (user as any).id = OWNER_ID;
    id = (await createMcpInstance(OWNER_ID, 'browserbase', 'BB', emptyGoogleTokens, null, 'browserbase', { access_token: 'bb_key' } as any, null)).instanceId;
    cookie = `session=${signCookie(await createSession('google-bb-settings'))}`;
  });


  it('stores the key without returning it, and keeps the Browserbase key', async () => {
    const res = await request(app).post(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie)
      .send({ settings: { modelName: 'openai/gpt-4.1', modelApiKey: KEY, verified: true } });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body).includes(KEY), false);
    const tokens = (await getMcpConnectionByInstanceId(id))?.providerTokens as any;
    assert.equal(tokens.access_token, 'bb_key');
    assert.equal(tokens.browserbaseSettings.modelApiKey, KEY);

    const read = await request(app).get(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie);
    assert.equal(JSON.stringify(read.body).includes(KEY), false);
    assert.equal(read.body.settings.modelApiKeySet, true);
  });

  it('an update without a key keeps the saved one; a bad body is 400', async () => {
    await request(app).post(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie)
      .send({ settings: { modelName: 'openai/gpt-4.1', keepAlive: true } }).expect(200);
    assert.equal(((await getMcpConnectionByInstanceId(id))?.providerTokens as any).browserbaseSettings.modelApiKey, KEY);
    const bad = await request(app).post(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie).send({ settings: { keepAlive: 'yes' } });
    assert.equal(bad.status, 400);
  });
});
