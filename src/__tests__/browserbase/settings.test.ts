import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

import { hostedUrlFor, mergeBrowserbaseSettings, publicBrowserbaseSettings, BROWSERBASE_DEFAULT_MODEL } from '../../browserbase/settings.js';
import { redactSecrets } from '../../browserbase/responseSafety.js';
import { hostedProxyFor, opEnd } from '../../browserbase/ops.js';
import { createWebOnlyApp, mergeProviderReconnectTokens } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import {
  createMcpInstance, disconnectMcpInstance, getMcpConnectionByInstanceId, GoogleTokens, patchMcpInstanceProviderTokens,
} from '../../mcpConnectionStore.js';
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

  it('keeps the stored model and key when a request leaves the model out; a blank model resets both', () => {
    const stored = { modelName: 'openai/gpt-4.1', modelApiKey: KEY, proxies: true };
    assert.deepEqual(mergeBrowserbaseSettings(stored, { verified: true }),
      { settings: { modelName: 'openai/gpt-4.1', modelApiKey: KEY, proxies: true, verified: true } });
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: '' }), { settings: { proxies: true } });
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: null }), { settings: { proxies: true } });
  });

  it('reuses a saved key only for the same provider', () => {
    const stored = { modelName: 'anthropic/claude-sonnet-4', modelApiKey: KEY };
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: 'anthropic/claude-opus-4' }),
      { settings: { modelName: 'anthropic/claude-opus-4', modelApiKey: KEY } });
    assert.match((mergeBrowserbaseSettings(stored, { modelName: 'openai/gpt-4.1' }) as any).error, /saved key is for anthropic.*openai API key/);
    assert.deepEqual(mergeBrowserbaseSettings(stored, { modelName: 'openai/gpt-4.1', modelApiKey: 'sk-other-0123456789' }),
      { settings: { modelName: 'openai/gpt-4.1', modelApiKey: 'sk-other-0123456789' } });
  });

  it('keeps stored flags a request leaves out', () => {
    assert.deepEqual(mergeBrowserbaseSettings({ proxies: true, keepAlive: true }, { verified: true }),
      { settings: { proxies: true, keepAlive: true, verified: true } });
    assert.deepEqual(mergeBrowserbaseSettings({ proxies: true }, { proxies: false }), { settings: {} });
  });

  it('scrubs the bare model key from an upstream error', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const result = body.method === 'tools/call'
        ? { isError: true, content: [{ type: 'text', text: `AI_APICallError: Incorrect API key provided: ${KEY}` }] }
        : { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'x', version: '1' } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' },
      });
    }) as typeof fetch;
    try {
      const { proxyHostedTool } = await import('../../browserbase/mcpProxyClient.js');
      await assert.rejects(
        () => proxyHostedTool('bb_key', 'extract', { instruction: 'x', sessionId: 's1' }, {}, { modelName: 'openai/gpt-4.1', modelApiKey: KEY }),
        (e: any) => !String(e.message).includes(KEY) && /\[redacted\]/.test(e.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('scrubs the key before any cut, so truncation cannot leave a prefix of it', async () => {
    // Shaped like no known credential, so only the exact-value scrub can catch
    // it. It straddles the transport's 400-character cut; the filler does not
    // repeat, since a repeated run is collapsed before any cut.
    const bare = 'Zq9Xw2Lm7Np4Rt6Vy8BcHk3J';
    const filler = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ').slice(0, 390);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const payload = body.method === 'tools/call'
        ? { error: { code: -32000, message: `${filler}${bare}` } }
        : { result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'x', version: '1' } } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' },
      });
    }) as typeof fetch;
    try {
      const { proxyHostedTool } = await import('../../browserbase/mcpProxyClient.js');
      await assert.rejects(
        () => proxyHostedTool('bb_key', 'extract', { instruction: 'x', sessionId: 's1' }, {}, { modelName: 'openai/gpt-4.1', modelApiKey: bare }),
        (e: any) => !String(e.message).includes(bare.slice(0, 6)) && /\[redacted\]/.test(e.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('end releases the session too, and only then says billing stopped', async () => {
    const proxy = async () => 'ok';
    let released = 0;
    const ok = await opEnd(proxy as any, { releaseSession: async () => { released++; } } as any, { sessionId: 's1' });
    assert.equal(released, 1);
    assert.match(ok, /no longer billing/);
    const failed = await opEnd(proxy as any, { releaseSession: async () => { throw new Error('409'); } } as any, { sessionId: 's1' });
    assert.doesNotMatch(failed, /no longer billing/);
    assert.match(failed, /may still be running/);
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
      let current: Record<string, boolean> = { proxies: true };
      const proxy = hostedProxyFor('bb_key', async () => current);
      assert.equal(await proxy('observe', { instruction: 'x', sessionId: 's1' }), 'ok');
      const first = urls.splice(0);
      current = { verified: true };
      assert.equal(await proxy('observe', { instruction: 'x', sessionId: 's1' }), 'ok');
      assert.ok(first.length > 0 && urls.length > 0);
      assert.ok(first.every((u) => new URL(u).searchParams.get('proxies') === 'true' && !new URL(u).searchParams.has('verified')));
      assert.ok(urls.every((u) => new URL(u).searchParams.get('verified') === 'true' && !new URL(u).searchParams.has('proxies')));
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
const dummyTokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const emptyGoogleTokens: GoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

describe('Browserbase settings dashboard routes', () => {
  const app = createWebOnlyApp();
  let cookie: string;
  let id: string;
  let ownerId: number;

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
    ownerId = user!.id!;
    id = (await createMcpInstance(ownerId, 'browserbase', 'BB', emptyGoogleTokens, null, 'browserbase', { access_token: 'bb_key' } as any, null)).instanceId;
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
    await patchMcpInstanceProviderTokens(id, { browserbaseSettings: { modelName: 'openai/gpt-4.1', modelApiKey: KEY } });
    await request(app).post(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie)
      .send({ settings: { modelName: 'openai/gpt-4.1', keepAlive: true } }).expect(200);
    assert.equal(((await getMcpConnectionByInstanceId(id))?.providerTokens as any).browserbaseSettings.modelApiKey, KEY);
    const bad = await request(app).post(`/api/instances/${id}/browserbase-settings`).set('Cookie', cookie).send({ settings: { keepAlive: 'yes' } });
    assert.equal(bad.status, 400);
  });

  it('answers 404, and writes nothing, when the connection is gone', async () => {
    const doomed = (await createMcpInstance(ownerId, 'browserbase', 'Doomed', emptyGoogleTokens, null, 'browserbase', { access_token: 'bb_key' } as any, null)).instanceId;
    await disconnectMcpInstance(doomed);
    const res = await request(app).post(`/api/instances/${doomed}/browserbase-settings`).set('Cookie', cookie).send({ settings: { proxies: true } });
    assert.equal(res.status, 404);
    assert.equal(await patchMcpInstanceProviderTokens(doomed, { browserbaseSettings: { proxies: true } }), false);
  });
});

describe('patchMcpInstanceProviderTokens with expect', () => {
  it('writes only while the expected keys still hold what the caller read', async () => {
    const id = (await createMcpInstance(1, 'browserbase', 'CAS', emptyGoogleTokens, null, 'browserbase', {
      access_token: 'bb_key', browserbaseSettings: { proxies: true, keepAlive: true },
    } as any, null)).instanceId;
    const stored = async () => (await getMcpConnectionByInstanceId(id))?.providerTokens as any;
    // A save landed since the read: refused, nothing written.
    assert.equal(await patchMcpInstanceProviderTokens(id, { browserbaseSettings: { verified: true } }, { expect: { browserbaseSettings: { proxies: true } } }), false);
    assert.deepEqual((await stored()).browserbaseSettings, { proxies: true, keepAlive: true });
    // Key order does not matter, like jsonb equality; absent is expected as undefined.
    assert.equal(await patchMcpInstanceProviderTokens(id, { browserbaseSettings: undefined }, { expect: { browserbaseSettings: { keepAlive: true, proxies: true } } }), true);
    assert.equal(await patchMcpInstanceProviderTokens(id, { browserbaseSettings: { verified: true } }, { expect: { browserbaseSettings: undefined } }), true);
    assert.deepEqual(await stored(), { access_token: 'bb_key', browserbaseSettings: { verified: true } });
  });
});
