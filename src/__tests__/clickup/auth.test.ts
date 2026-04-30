import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import http from 'http';
import { authenticateRequest, AuthDeps } from '../../mcpAuthenticate.js';
import { createClickUpSession } from '../../userSession.js';
import type { McpConnection } from '../../mcpConnectionStore.js';
import type { UserRecord } from '../../userStore.js';

const fakeUser = { id: 'u1', apiKey: 'validkey', email: 'test@test.com', tokens: null };
const fakeClickUpConnection: McpConnection = {
  id: 1,
  userId: 'u1' as any,
  mcpSlug: 'clickup',
  instanceId: 'cu-inst1',
  instanceName: 'My ClickUp',
  googleEmail: null,
  googleTokens: { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 },
  connectedAt: '2024-01-01',
  updatedAt: '2024-01-01',
  provider: 'clickup',
  providerTokens: { access_token: 'clickup-token-abc' },
  providerEmail: 'user@clickup.com',
};

const fakeClickUpSession = { clickUpAccessToken: 'clickup-token-abc' } as any;

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    loadUsers: mock.fn(async () => {}),
    getUserByApiKey: mock.fn(async (key: string) => key === 'validkey' ? fakeUser : null),
    getUserById: mock.fn(async (id: number) => String(id) === String(fakeUser.id) ? fakeUser : null),
    loadClientCredentials: mock.fn(async () => ({ client_id: 'gcid', client_secret: 'gsec' })),
    getMcpConnection: mock.fn(async () => null),
    getMcpConnectionByInstanceId: mock.fn(async () => null),
    getMcpCatalog: mock.fn(async () => null),
    createUserSession: mock.fn(async () => ({} as any)),
    createUserSessionFromConnection: mock.fn(async () => ({} as any)),
    createClickUpSession: mock.fn(() => fakeClickUpSession),
    createSlackBotSession: mock.fn(() => ({} as any)),
    createSlackUserSession: mock.fn(() => ({} as any)),
    ...overrides,
  };
}

function makeRequest(opts: { url?: string; authorization?: string } = {}): http.IncomingMessage {
  return {
    headers: { authorization: opts.authorization },
    url: opts.url || '/',
  } as any;
}

describe('ClickUp Authentication', () => {
  it('should use createClickUpSession for ClickUp connections with instanceId', async () => {
    const deps = makeDeps({
      getMcpConnectionByInstanceId: mock.fn(async () => fakeClickUpConnection),
    });
    const req = makeRequest({ authorization: 'Bearer validkey.cu-inst1' });
    const session = await authenticateRequest(req, 'clickup', deps);
    assert.equal(session, fakeClickUpSession);
    assert.equal((deps.createClickUpSession as any).mock.calls.length, 1);
    // Should NOT call Google session factory
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 0);
  });

  it('should use createClickUpSession for ClickUp connections in legacy flow', async () => {
    const deps = makeDeps({
      getMcpConnection: mock.fn(async () => fakeClickUpConnection),
    });
    const req = makeRequest({ authorization: 'Bearer validkey' });
    const session = await authenticateRequest(req, 'clickup', deps);
    assert.equal(session, fakeClickUpSession);
    assert.equal((deps.createClickUpSession as any).mock.calls.length, 1);
  });

  it('should still use Google flow for Google connections with instanceId', async () => {
    const googleConnection = { ...fakeClickUpConnection, provider: 'google', instanceId: 'g-inst1' };
    const fakeGoogleSession = { googleDocs: {} } as any;
    const deps = makeDeps({
      getMcpConnectionByInstanceId: mock.fn(async () => googleConnection),
      getMcpCatalog: mock.fn(async () => ({ googleClientId: 'cid', googleClientSecret: 'csec' })),
      createUserSessionFromConnection: mock.fn(async () => fakeGoogleSession),
    });
    const req = makeRequest({ authorization: 'Bearer validkey.g-inst1' });
    const session = await authenticateRequest(req, 'google-docs', deps);
    assert.equal(session, fakeGoogleSession);
    assert.equal((deps.createClickUpSession as any).mock.calls.length, 0);
    assert.equal((deps.createUserSessionFromConnection as any).mock.calls.length, 1);
  });
});

describe('createClickUpSession', () => {
  it('should create a session with clickUpAccessToken', () => {
    const user: UserRecord = {
      id: 1 as any,
      apiKey: 'key123',
      email: 'test@test.com',
      name: 'Test',
      authMethod: 'google',
    } as any;

    const session = createClickUpSession(user, fakeClickUpConnection);
    assert.equal(session.clickUpAccessToken, 'clickup-token-abc');
    assert.equal(session.apiKey, 'key123');
    assert.equal(session.email, 'test@test.com');
    assert.equal(session.mcpSlug, 'clickup');
    // Google clients should be null
    assert.equal(session.googleDocs, null);
    assert.equal(session.oauthClient, null);
  });

  it('should return cached session on second call', () => {
    const user: UserRecord = {
      id: 2 as any,
      apiKey: 'key456',
      email: 'test2@test.com',
      name: 'Test2',
      authMethod: 'google',
    } as any;

    const conn = { ...fakeClickUpConnection, instanceId: 'cu-cache-test' };
    const session1 = createClickUpSession(user, conn);
    const session2 = createClickUpSession(user, conn);
    assert.equal(session1, session2); // Same reference (cached)
  });

  it('should throw when providerTokens has no access_token', () => {
    const user: UserRecord = {
      id: 3 as any,
      apiKey: 'key789',
      email: 'test3@test.com',
      name: 'Test3',
      authMethod: 'google',
    } as any;

    const conn = { ...fakeClickUpConnection, instanceId: 'cu-no-token', providerTokens: undefined };
    assert.throws(
      () => createClickUpSession(user, conn),
      { message: /ClickUp access token missing/ }
    );
  });
});
