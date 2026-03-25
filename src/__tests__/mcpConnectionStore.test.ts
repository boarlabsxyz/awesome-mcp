import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set DATA_DIR to a temp directory before importing the module
const tmpDir = path.join(__dirname, '..', '..', '.test-data-' + Date.now());
process.env.DATA_DIR = tmpDir;

// Dynamic import after setting env
const store = await import('../mcpConnectionStore.js');

const sampleTokens: store.GoogleTokens = {
  access_token: 'access-123',
  refresh_token: 'refresh-456',
  scope: 'email profile',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

describe('mcpConnectionStore (file-based)', () => {
  before(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('createMcpInstance creates a new instance and returns it', async () => {
    const conn = await store.createMcpInstance(1, 'google-docs', 'Work Docs', sampleTokens, 'user@example.com');
    assert.equal(conn.userId, 1);
    assert.equal(conn.mcpSlug, 'google-docs');
    assert.equal(conn.instanceName, 'Work Docs');
    assert.equal(conn.googleEmail, 'user@example.com');
    assert.equal(conn.googleTokens.access_token, 'access-123');
    assert.ok(conn.instanceId, 'should have an instanceId');
    assert.ok(conn.connectedAt, 'should have connectedAt');
  });

  it('getMcpConnectionByInstanceId retrieves a created instance', async () => {
    const created = await store.createMcpInstance(2, 'google-calendar', 'Cal', sampleTokens, 'cal@example.com');
    const fetched = await store.getMcpConnectionByInstanceId(created.instanceId);
    assert.ok(fetched);
    assert.equal(fetched.instanceId, created.instanceId);
    assert.equal(fetched.googleEmail, 'cal@example.com');
    assert.equal(fetched.mcpSlug, 'google-calendar');
  });

  it('getMcpConnectionByInstanceId returns null for unknown instanceId', async () => {
    const result = await store.getMcpConnectionByInstanceId('nonexistent-id');
    assert.equal(result, null);
  });

  it('updateMcpInstanceGoogleEmail persists the new email', async () => {
    const conn = await store.createMcpInstance(3, 'google-docs', 'Test', sampleTokens, 'old@example.com');

    const updated = await store.updateMcpInstanceGoogleEmail(conn.instanceId, 'new@example.com');
    assert.equal(updated, true);

    const fetched = await store.getMcpConnectionByInstanceId(conn.instanceId);
    assert.ok(fetched);
    assert.equal(fetched.googleEmail, 'new@example.com');
  });

  it('updateMcpInstanceGoogleEmail returns false for unknown instanceId', async () => {
    const result = await store.updateMcpInstanceGoogleEmail('nonexistent-id', 'any@example.com');
    assert.equal(result, false);
  });

  it('updateMcpInstanceName persists the new name', async () => {
    const conn = await store.createMcpInstance(4, 'google-docs', 'OldName', sampleTokens, null);

    const updated = await store.updateMcpInstanceName(conn.instanceId, 'NewName');
    assert.equal(updated, true);

    const fetched = await store.getMcpConnectionByInstanceId(conn.instanceId);
    assert.ok(fetched);
    assert.equal(fetched.instanceName, 'NewName');
  });

  it('updateMcpInstanceTokens persists merged tokens', async () => {
    const conn = await store.createMcpInstance(5, 'google-docs', 'TokenTest', sampleTokens, null);

    await store.updateMcpInstanceTokens(conn.instanceId, {
      access_token: 'new-access-789',
      expiry_date: 9999999999,
    });

    const fetched = await store.getMcpConnectionByInstanceId(conn.instanceId);
    assert.ok(fetched);
    assert.equal(fetched.googleTokens.access_token, 'new-access-789');
    assert.equal(fetched.googleTokens.expiry_date, 9999999999);
    // refresh_token should be preserved from original
    assert.equal(fetched.googleTokens.refresh_token, 'refresh-456');
  });

  it('disconnectMcpInstance removes the instance', async () => {
    const conn = await store.createMcpInstance(6, 'google-docs', 'ToDelete', sampleTokens, null);

    const deleted = await store.disconnectMcpInstance(conn.instanceId);
    assert.equal(deleted, true);

    const fetched = await store.getMcpConnectionByInstanceId(conn.instanceId);
    assert.equal(fetched, null);
  });

  it('disconnectMcpInstance returns false for unknown instanceId', async () => {
    const result = await store.disconnectMcpInstance('nonexistent-id');
    assert.equal(result, false);
  });

  it('getUserConnectedMcps returns all instances for a user', async () => {
    const userId = 100;
    await store.createMcpInstance(userId, 'google-docs', 'Docs1', sampleTokens, 'a@test.com');
    await store.createMcpInstance(userId, 'google-calendar', 'Cal1', sampleTokens, 'b@test.com');

    const connections = await store.getUserConnectedMcps(userId);
    assert.ok(connections.length >= 2);
    const slugs = connections.map(c => c.mcpSlug);
    assert.ok(slugs.includes('google-docs'));
    assert.ok(slugs.includes('google-calendar'));
  });
});
