import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createSlackBotSession,
  createPeopleForceSession,
  createHubSpotSession,
  createOutlineSession,
  clearMcpSessionCache,
} from '../userSession.js';

// mcpSessionCache is a per-process Map with no TTL, so a built session outlives
// any credential change made in a DIFFERENT process — and the dashboard runs in
// a different process from the per-MCP subdomains, so clearMcpSessionCache()
// there cannot reach the cache that actually serves tool calls. Re-entering a
// rotated token would appear to succeed and change nothing.
//
// Redis is no way out: mcp_tokens:instance:* caches googleTokens only, and
// provider_tokens are re-read from Postgres on every authenticate. The fresh
// credential is therefore already in hand at cache-lookup time, so the cache
// can simply verify it built from that same credential — self-invalidating in
// every process, with no pub/sub channel to build or keep alive.

const user = { id: 4242, apiKey: 'apikey-cred-test', email: 'cred@example.com' } as any;

function connection(instanceId: string, mcpSlug: string, providerTokens: Record<string, unknown>) {
  return { instanceId, mcpSlug, userId: user.id, providerTokens } as any;
}

describe('session cache is keyed to the credential it was built from', () => {
  beforeEach(() => {
    for (const id of ['inst-slack', 'inst-pf', 'inst-hs', 'inst-outline']) {
      clearMcpSessionCache(user.apiKey, id);
    }
  });

  it('serves the cached session while the credential is unchanged', () => {
    const conn = connection('inst-slack', 'slack-bot', { access_token: 'xoxb-a' });
    const first = createSlackBotSession(user, conn);
    const second = createSlackBotSession(user, conn);
    // Same object: the cache is still doing its job on the hot path.
    assert.equal(first, second);
  });

  it('rebuilds a Slack bot session after the token is replaced elsewhere', () => {
    const before = createSlackBotSession(user, connection('inst-slack', 'slack-bot', { access_token: 'xoxb-old' }));
    assert.equal(before.slackBotToken, 'xoxb-old');

    // Simulates another process having written a new credential: same user,
    // same instance, freshly-read connection.
    const after = createSlackBotSession(user, connection('inst-slack', 'slack-bot', { access_token: 'xoxb-new' }));
    assert.equal(after.slackBotToken, 'xoxb-new', 'stale token would be used for the life of the process');
    assert.notEqual(after, before);
  });

  it('rebuilds a PeopleForce session after the API key is rotated', () => {
    const before = createPeopleForceSession(user, connection('inst-pf', 'peopleforce', { access_token: 'pf-old' }));
    assert.equal(before.peopleForceAccessToken, 'pf-old');
    const after = createPeopleForceSession(user, connection('inst-pf', 'peopleforce', { access_token: 'pf-new' }));
    assert.equal(after.peopleForceAccessToken, 'pf-new');
  });

  it('rebuilds a HubSpot session after the token is rotated', () => {
    const before = createHubSpotSession(user, connection('inst-hs', 'hubspot', { access_token: 'hs-old' }));
    assert.equal(before.hubspotAccessToken, 'hs-old');
    const after = createHubSpotSession(user, connection('inst-hs', 'hubspot', { access_token: 'hs-new' }));
    assert.equal(after.hubspotAccessToken, 'hs-new');
  });

  it('rebuilds an Outline session after the API key is rotated', () => {
    const base = { baseUrl: 'https://wiki.example.test' };
    const before = createOutlineSession(user, connection('inst-outline', 'outline', { ...base, access_token: 'ol-old' }));
    assert.equal(before.outlineAccessToken, 'ol-old');
    const after = createOutlineSession(user, connection('inst-outline', 'outline', { ...base, access_token: 'ol-new' }));
    assert.equal(after.outlineAccessToken, 'ol-new');
  });

  it('keeps sessions for different instances independent', () => {
    // The guard must not turn the cache into a single-entry cache: two
    // instances of the same provider hold different credentials by design.
    const a = createSlackBotSession(user, connection('inst-slack', 'slack-bot', { access_token: 'xoxb-a' }));
    const b = createSlackBotSession(user, connection('inst-pf', 'slack-bot', { access_token: 'xoxb-b' }));
    assert.equal(a.slackBotToken, 'xoxb-a');
    assert.equal(b.slackBotToken, 'xoxb-b');
    assert.equal(createSlackBotSession(user, connection('inst-slack', 'slack-bot', { access_token: 'xoxb-a' })), a);
  });
});
