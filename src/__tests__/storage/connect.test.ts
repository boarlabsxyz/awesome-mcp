import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { connectStorageMcp, type StorageConnectDeps } from '../../storage/connect.js';

function deps(existing: Array<{ mcpSlug: string; instanceId: string; instanceName: string }>): StorageConnectDeps {
  return {
    isDatabaseAvailable: () => true,
    getUserConnectedMcps: async () => existing,
    createMcpInstance: mock.fn(async () => ({ instanceId: 'new1', instanceName: 'Storage' })) as any,
  };
}

describe('connectStorageMcp', () => {
  it('creates one credential-less connector', async () => {
    const d = deps([{ mcpSlug: 'google-docs', instanceId: 'g1', instanceName: 'Docs' }]);
    const result = await connectStorageMcp({ id: 3 }, d);
    assert.deepEqual(result, { outcome: 'created', instanceId: 'new1', instanceName: 'Storage' });
    const args = (d.createMcpInstance as any).mock.calls[0].arguments;
    assert.equal(args[0], 3);
    assert.equal(args[1], 'storage');
    assert.equal(args[5], 'storage');
  });

  it('returns the existing connector instead of making a second', async () => {
    const d = deps([{ mcpSlug: 'storage', instanceId: 's1', instanceName: 'Storage' }]);
    const result = await connectStorageMcp({ id: 3 }, d);
    assert.deepEqual(result, { outcome: 'exists', instanceId: 's1', instanceName: 'Storage' });
    assert.equal((d.createMcpInstance as any).mock.calls.length, 0);
  });

  it('answers a lost race on the unique index with the winning connector', async () => {
    let lookups = 0;
    const d: StorageConnectDeps = {
      isDatabaseAvailable: () => true,
      // First lookup (before the insert) sees nothing; the re-read sees the winner.
      getUserConnectedMcps: async () => (lookups++ === 0 ? [] : [{ mcpSlug: 'storage', instanceId: 'won', instanceName: 'Storage' }]),
      createMcpInstance: (async () => { throw Object.assign(new Error('dup'), { code: '23505' }); }) as any,
    };
    assert.deepEqual(await connectStorageMcp({ id: 3 }, d), { outcome: 'exists', instanceId: 'won', instanceName: 'Storage' });
  });

  it('refuses without a database instead of creating a connector no tool can serve', async () => {
    const d = { ...deps([]), isDatabaseAvailable: () => false };
    assert.deepEqual(await connectStorageMcp({ id: 3 }, d), { outcome: 'unavailable' });
    assert.equal((d.createMcpInstance as any).mock.calls.length, 0);
  });
});
