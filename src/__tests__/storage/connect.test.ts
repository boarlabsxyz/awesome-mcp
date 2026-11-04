import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { connectStorageMcp, type StorageConnectDeps } from '../../storage/connect.js';

function deps(existing: Array<{ mcpSlug: string; instanceId: string; instanceName: string }>): StorageConnectDeps {
  return {
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
});
