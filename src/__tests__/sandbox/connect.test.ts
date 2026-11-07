import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { connectSandboxMcp, sandboxConfigured, type SandboxConnectDeps } from '../../sandbox/connect.js';

function deps(over: Partial<SandboxConnectDeps> = {}): SandboxConnectDeps {
  return {
    isConfigured: () => true,
    getUserConnectedMcps: mock.fn(async () => []),
    createMcpInstance: mock.fn(async () => ({ instanceId: 'sbx-inst', instanceName: 'Sandbox' })) as any,
    ...over,
  };
}

describe('connectSandboxMcp', () => {
  it('refuses without a runner or Redis, creating nothing', async () => {
    const d = deps({ isConfigured: () => false });
    assert.deepEqual(await connectSandboxMcp({ id: 1 }, d), { outcome: 'unavailable' });
    assert.equal((d.createMcpInstance as any).mock.calls.length, 0);
  });

  it('creates one sandbox connector, and answers exists for a second', async () => {
    const d = deps();
    assert.equal((await connectSandboxMcp({ id: 1 }, d)).outcome, 'created');
    const call = (d.createMcpInstance as any).mock.calls[0].arguments;
    assert.equal(call[1], 'sandbox');
    assert.equal(call[5], 'sandbox');

    const again = deps({ getUserConnectedMcps: mock.fn(async () => [{ mcpSlug: 'sandbox', instanceId: 'old', instanceName: 'Sandbox' }]) });
    assert.deepEqual(await connectSandboxMcp({ id: 1 }, again), { outcome: 'exists', instanceId: 'old', instanceName: 'Sandbox' });
  });

  it('counts a remote Sandbox service as ready: its runner settings are on that service, not this one', () => {
    assert.equal(sandboxConfigured({ SANDBOX_MCP_URL: 'https://sandbox.example' }, true), true);
    assert.equal(sandboxConfigured({ SANDBOX_RUNNER_URL: 'http://runner:8080', SANDBOX_RUNNER_SECRET: 's' }, true), true);
    assert.equal(sandboxConfigured({ SANDBOX_RUNNER_URL: 'http://runner:8080' }, true), false, 'a runner URL without its secret cannot be called');
    assert.equal(sandboxConfigured({ SANDBOX_RUNNER: 'local' }, true), true);
    assert.equal(sandboxConfigured({}, true), false);
    assert.equal(sandboxConfigured({ SANDBOX_MCP_URL: 'https://sandbox.example' }, false), false, 'still needs a database');
  });
});
