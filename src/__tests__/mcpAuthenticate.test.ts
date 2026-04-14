import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach } from 'node:test';
import http from 'http';
import { authenticateRequest, AuthDeps } from '../mcpAuthenticate.js';

const fakeUser = { id: 'u1', email: 'test@test.com', tokens: { refresh_token: 'rt' } };
const fakeConnection = { instanceId: 'inst1', userId: 'u1', mcpSlug: 'google-docs', googleEmail: 'g@g.com', googleTokens: { refresh_token: 'rt2' } };
const fakeSession = { googleDocs: {} } as any;
const fakeCatalog = { googleClientId: 'cid', googleClientSecret: 'csec' };

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    loadUsers: mock.fn(async () => {}),
    getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
    getUserById: mock.fn(async (id: number) => String(id) === String(fakeUser.id) ? fakeUser : null),
    loadClientCredentials: mock.fn(async () => ({ client_id: 'gcid', client_secret: 'gsec' })),
    getMcpConnection: mock.fn(async () => null),
    getMcpConnectionByInstanceId: mock.fn(async () => null),
    getMcpCatalog: mock.fn(async () => null),
    createUserSession: mock.fn(async () => fakeSession),
    createUserSessionFromConnection: mock.fn(async () => fakeSession),
    createClickUpSession: mock.fn(() => fakeSession),
    ...overrides,
  };
}

function makeRequest(opts: { url?: string; authorization?: string } = {}): http.IncomingMessage {
  return {
    headers: { authorization: opts.authorization },
    url: opts.url || '/',
  } as any;
}

describe('authenticateRequest', () => {
  it('returns undefined for stdio mode (no request)', async () => {
    const deps = makeDeps();
    const result = await authenticateRequest(undefined, 'google-docs', deps);
    assert.equal(result, undefined);
  });

  it('throws 401 when no API key provided', async () => {
    const deps = makeDeps();
    try {
      await authenticateRequest(makeRequest(), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 401);
      assert.ok(e.statusText.includes('Missing API key'));
    }
  });

  it('extracts API key from Bearer header', async () => {
    const deps = makeDeps({ getMcpConnection: mock.fn(async () => fakeConnection) });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'google-docs', deps);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });

  it('extracts API key from query param', async () => {
    const deps = makeDeps({ getMcpConnection: mock.fn(async () => fakeConnection) });
    await authenticateRequest(makeRequest({ url: '/?apiKey=validkey' }), 'google-docs', deps);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });

  it('throws 401 for invalid API key', async () => {
    const deps = makeDeps();
    try {
      await authenticateRequest(makeRequest({ authorization: 'Bearer badkey' }), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 401);
      assert.ok(e.statusText.includes('Invalid API key'));
    }
  });

  it('throws 403 when user has no id', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async () => ({ ...fakeUser, id: undefined })),
    });
    try {
      await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 403);
      assert.ok(e.statusText.includes('User ID not found'));
    }
  });

  it('handles compound token format (apiKey.instanceId)', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
      getMcpConnectionByInstanceId: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => fakeCatalog),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey.inst1' }), 'google-docs', deps);
    assert.equal((deps.getMcpConnectionByInstanceId as any).mock.calls.length, 1);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });

  it('treats entire token as apiKey when compound parse fails', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'unknown.key' ? fakeUser : null),
      getMcpConnection: mock.fn(async () => fakeConnection),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer unknown.key' }), 'google-docs', deps);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });

  it('throws 404 when instance not found', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
      getMcpConnectionByInstanceId: mock.fn(async () => null),
    });
    try {
      await authenticateRequest(makeRequest({ authorization: 'Bearer validkey.badinst' }), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 404);
      assert.ok(e.statusText.includes('Instance not found'));
    }
  });

  it('throws 403 when user does not own instance', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
      getMcpConnectionByInstanceId: mock.fn(async () => ({ ...fakeConnection, userId: 'other-user' })),
    });
    try {
      await authenticateRequest(makeRequest({ authorization: 'Bearer validkey.inst1' }), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 403);
      assert.ok(e.statusText.includes('do not have access'));
    }
  });

  it('uses catalog credentials when available for instance flow', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
      getMcpConnectionByInstanceId: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => fakeCatalog),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey.inst1' }), 'google-docs', deps);
    assert.equal((deps.loadClientCredentials as any).mock.calls.length, 0);
  });

  it('falls back to global credentials when catalog has none', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
      getMcpConnectionByInstanceId: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => null),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey.inst1' }), 'google-docs', deps);
    assert.equal((deps.loadClientCredentials as any).mock.calls.length, 1);
  });

  it('uses legacy flow when no instanceId', async () => {
    const deps = makeDeps({
      getMcpConnection: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => fakeCatalog),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'google-docs', deps);
    assert.equal((deps.getMcpConnection as any).mock.calls.length, 1);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });

  it('falls back to global tokens when no connection exists', async () => {
    const deps = makeDeps();
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'google-docs', deps);
    assert.equal((deps.createUserSession as any).mock.calls.length, 1);
  });

  it('throws 403 when no connection and no global tokens', async () => {
    const deps = makeDeps({
      getUserByApiKey: mock.fn(async () => ({ ...fakeUser, tokens: null })),
    });
    try {
      await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'google-docs', deps);
      assert.fail('expected throw');
    } catch (e: any) {
      assert.equal(e.status, 403);
      assert.ok(e.statusText.includes('MCP not connected'));
    }
  });

  it('reads instanceId from query param when not in compound token', async () => {
    const deps = makeDeps({
      getMcpConnectionByInstanceId: mock.fn(async () => fakeConnection),
    });
    await authenticateRequest(makeRequest({ url: '/?apiKey=validkey&instanceId=inst1' }), 'google-docs', deps);
    assert.equal((deps.getMcpConnectionByInstanceId as any).mock.calls.length, 1);
  });

  it('uses legacy catalog credentials in legacy flow', async () => {
    const deps = makeDeps({
      getMcpConnection: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => fakeCatalog),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'my-slug', deps);
    assert.equal((deps.loadClientCredentials as any).mock.calls.length, 0);
  });

  it('falls back to loadClientCredentials in legacy flow when catalog has no creds', async () => {
    const deps = makeDeps({
      getMcpConnection: mock.fn(async () => fakeConnection),
      getMcpCatalog: mock.fn(async () => ({})),
    });
    await authenticateRequest(makeRequest({ authorization: 'Bearer validkey' }), 'my-slug', deps);
    assert.equal((deps.loadClientCredentials as any).mock.calls.length, 1);
  });
});
