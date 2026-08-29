import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConnectionHealth } from '../website/connectionHealth.js';

// The dashboard shows Reconnect only on 'reauth', so the line between "the
// provider rejected this credential" and "the provider could not answer" is
// the whole feature. Get it wrong toward 'reauth' and one flaky minute
// upstream lights up every row and trains the user to ignore the button; get
// it wrong toward 'healthy' and a revoked grant stays unrepairable, which is
// the original Gmail bug.

const conn = (provider: string, extra: Record<string, any> = {}) => ({
  instanceId: 'inst-1', mcpSlug: provider, userId: 1, provider,
  providerTokens: { access_token: 'tok', ...extra },
  googleTokens: undefined,
} as any);

const NO_CREDS = { clientId: null, clientSecret: null };
const CREDS = { clientId: 'cid', clientSecret: 'secret' };

const respond = (status: number, body: unknown = {}) =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as any;

describe('checkConnectionHealth — Google', () => {
  const google = { ...conn('google'), providerTokens: {}, googleTokens: { refresh_token: 'r' } } as any;

  it('reports reauth when Google says invalid_grant', async () => {
    // The exact signal a revoked or expired grant produces, and the one thing
    // stored token state can never reveal.
    const health = await checkConnectionHealth(google, CREDS, {
      probeGoogle: async () => ({ state: 'reauth', reason: 'invalid_grant' }),
    });
    assert.equal(health.state, 'reauth');
  });

  it('reports healthy when the refresh succeeds', async () => {
    const health = await checkConnectionHealth(google, CREDS, {
      probeGoogle: async () => ({ state: 'healthy' }),
    });
    assert.equal(health.state, 'healthy');
  });

  it('reports reauth when no refresh token is stored at all', async () => {
    const noRefresh = { ...google, googleTokens: { refresh_token: '' } };
    const health = await checkConnectionHealth(noRefresh, CREDS);
    assert.equal(health.state, 'reauth');
  });

  it('reports unknown — not reauth — when the deployment has no OAuth client', async () => {
    // A missing client_id is our misconfiguration. Telling the user to
    // reconnect would send them into a flow that cannot work.
    const health = await checkConnectionHealth(google, NO_CREDS);
    assert.equal(health.state, 'unknown');
  });
});

describe('checkConnectionHealth — Slack', () => {
  it('treats 200 + ok:false + invalid_auth as reauth', async () => {
    // Slack answers 200 for auth failures, so a status-only check would call a
    // revoked token healthy.
    const health = await checkConnectionHealth(conn('slack'), NO_CREDS, {
      fetchImpl: respond(200, { ok: false, error: 'invalid_auth' }),
    });
    assert.equal(health.state, 'reauth');
  });

  it('treats token_revoked as reauth', async () => {
    const health = await checkConnectionHealth(conn('slack-bot'), NO_CREDS, {
      fetchImpl: respond(200, { ok: false, error: 'token_revoked' }),
    });
    assert.equal(health.state, 'reauth');
  });

  it('treats an unrecognised Slack error as unknown', async () => {
    // ratelimited, fatal_error, internal_error — none mean "reconnect".
    const health = await checkConnectionHealth(conn('slack'), NO_CREDS, {
      fetchImpl: respond(200, { ok: false, error: 'ratelimited' }),
    });
    assert.equal(health.state, 'unknown');
  });

  it('treats ok:true as healthy', async () => {
    const health = await checkConnectionHealth(conn('slack'), NO_CREDS, {
      fetchImpl: respond(200, { ok: true }),
    });
    assert.equal(health.state, 'healthy');
  });

  it('reports reauth when no token is stored', async () => {
    const empty = { ...conn('slack'), providerTokens: {} } as any;
    assert.equal((await checkConnectionHealth(empty, NO_CREDS)).state, 'reauth');
  });
});

describe('checkConnectionHealth — ClickUp and transport failures', () => {
  it('maps 401 to reauth', async () => {
    const health = await checkConnectionHealth(conn('clickup'), NO_CREDS, { fetchImpl: respond(401) });
    assert.equal(health.state, 'reauth');
  });

  it('maps a provider 500 to unknown, never reauth', async () => {
    const health = await checkConnectionHealth(conn('clickup'), NO_CREDS, { fetchImpl: respond(500) });
    assert.equal(health.state, 'unknown');
  });

  it('maps a network failure to unknown', async () => {
    const health = await checkConnectionHealth(conn('clickup'), NO_CREDS, {
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any,
    });
    assert.equal(health.state, 'unknown');
  });

  it('maps a 200 to healthy', async () => {
    const health = await checkConnectionHealth(conn('clickup'), NO_CREDS, { fetchImpl: respond(200) });
    assert.equal(health.state, 'healthy');
  });
});

describe('checkConnectionHealth — unknown providers never prompt', () => {
  it('returns unknown for a provider with no probe', async () => {
    const health = await checkConnectionHealth(conn('some-future-provider'), NO_CREDS);
    assert.equal(health.state, 'unknown');
  });

  it('never throws, whatever the probe does', async () => {
    const health = await checkConnectionHealth(conn('clickup'), NO_CREDS, {
      fetchImpl: (() => { throw new Error('boom'); }) as any,
    });
    assert.equal(health.state, 'unknown');
  });
});

describe('checkConnectionHealth — a refreshable connection is not a broken one', () => {
  // Outline (~1h) and HubSpot (~30min) OAuth access tokens are routinely
  // expired at rest and refreshed at tool-call time. Reading that 401 as
  // "reconnect" would put the button back on healthy connections permanently,
  // which is the complaint this whole change exists to answer.
  const withRefresh = (provider: string) => ({
    instanceId: 'i', mcpSlug: provider, userId: 1, provider,
    providerTokens: { access_token: 'expired', refresh_token: 'r', baseUrl: 'https://x.test' },
  } as any);
  const withoutRefresh = (provider: string) => ({
    instanceId: 'i', mcpSlug: provider, userId: 1, provider,
    providerTokens: { access_token: 'bad', baseUrl: 'https://x.test' },
  } as any);

  for (const provider of ['outline', 'hubspot']) {
    it(`${provider}: 401 with a refresh token stored is unknown, not reauth`, async () => {
      const health = await checkConnectionHealth(withRefresh(provider), NO_CREDS, {
        fetchImpl: respond(401, {}),
      });
      assert.equal(health.state, 'unknown');
    });

    it(`${provider}: 401 with no refresh token is conclusive`, async () => {
      const health = await checkConnectionHealth(withoutRefresh(provider), NO_CREDS, {
        fetchImpl: respond(401, {}),
      });
      assert.equal(health.state, 'reauth');
    });

    it(`${provider}: a working token is healthy either way`, async () => {
      const ok = await checkConnectionHealth(withRefresh(provider), NO_CREDS, {
        fetchImpl: respond(200, { data: [] }),
      });
      assert.equal(ok.state, 'healthy');
    });
  }

  it('peopleforce has no refresh token, so a rejection still prompts', async () => {
    const health = await checkConnectionHealth(withoutRefresh('peopleforce'), NO_CREDS, {
      fetchImpl: respond(401, {}),
    });
    assert.equal(health.state, 'reauth');
  });
});

describe('checkConnectionHealth — config problems are not credential problems', () => {
  it('reports unknown when no Outline base URL is configured, without probing', async () => {
    // validateOutlineToken returns 400 for a missing base URL — the same status
    // it uses for a rejected credential — so this reached the user as an amber
    // Reconnect button that could not possibly fix a missing base URL.
    const previous = process.env.OUTLINE_BASE_URL;
    delete process.env.OUTLINE_BASE_URL;
    let called = false;
    try {
      const health = await checkConnectionHealth(
        { instanceId: 'i', mcpSlug: 'outline', userId: 1, provider: 'outline',
          providerTokens: { access_token: 'tok' } } as any,
        NO_CREDS,
        { fetchImpl: (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as any },
      );
      assert.equal(health.state, 'unknown');
      assert.equal(called, false, 'should not probe at all without a base URL');
    } finally {
      if (previous === undefined) delete process.env.OUTLINE_BASE_URL;
      else process.env.OUTLINE_BASE_URL = previous;
    }
  });

  it('still probes when the base URL comes from the connection record', async () => {
    const health = await checkConnectionHealth(
      { instanceId: 'i', mcpSlug: 'outline', userId: 1, provider: 'outline',
        providerTokens: { access_token: 'tok', baseUrl: 'https://wiki.example.test' } } as any,
      NO_CREDS,
      { fetchImpl: respond(200, { data: { user: {} } }) },
    );
    assert.equal(health.state, 'healthy');
  });
});
