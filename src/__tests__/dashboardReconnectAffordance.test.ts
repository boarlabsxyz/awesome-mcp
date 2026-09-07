import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard's reconnect affordance has silently regressed three times, all
// three because it is inline browser JS with no test boundary:
//
//   1. needsReconnect() returned false for every non-Google provider, so a
//      Slack row never offered Reconnect while the tools were telling the user
//      to "reconnect from the dashboard to re-consent".
//   2. The replacement only covered non-Google providers, leaving Google MCPs
//      with a revoked-but-present refresh token showing no button at all —
//      computeTokenStatus reports isExpired=false whenever a refresh_token
//      exists, so a dead Gmail connection rendered as perfectly healthy.
//   3. Gating the button on a live 'reauth' health verdict hid it again for the
//      two breakages a probe cannot see: a scope added to the catalog (the
//      token still works for every OLD tool, so the probe says 'healthy') and a
//      provider that could not be reached ('unknown').
//
// The button is therefore drawn wherever repair is POSSIBLE, and the probe only
// decides whether it is highlighted. This lifts the predicates out of
// dashboard.html and exercises them directly, so a fourth regression fails here
// instead of in someone's browser.

const dashboardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'dashboard.html',
);

const html = fs.readFileSync(dashboardPath, 'utf8');

/** Pull a top-level function out of the page's inline script by signature. */
function fnSource(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`function ${escaped} \\{[\\s\\S]*?\\n {4}\\}`));
  assert.ok(match, `${signature} not found in dashboard.html — was it renamed?`);
  return match[0];
}

/** Rebuild a closure over the page's connectionHealth Map. */
function build<T>(verdicts: Record<string, string>, signatures: string[], returns: string): T {
  return new Function(`
    const connectionHealth = new Map(Object.entries(${JSON.stringify(verdicts)}));
    ${signatures.map(fnSource).join('\n')}
    return ${returns};
  `)() as T;
}

// Every state the probe can leave a row in, including "never answered".
const VERDICTS: Record<string, string>[] = [{}, { i1: 'healthy' }, { i1: 'unknown' }, { i1: 'reauth' }];

const OAUTH_MCP = { oauthAuthorizationUrl: 'https://app.clickup.com/api' };
const PASTE_MCP = { oauthAuthorizationUrl: '' };

// canReauthorize() is the button gate: it answers "could re-consent even work
// here", and nothing further is required before the button is drawn. A provider
// wrongly excluded here can never show the button at all.
describe('dashboard canReauthorize()', () => {
  const canReauthorize = build<(i: any, m: any) => boolean>({}, ['canReauthorize(instance, mcp)'], 'canReauthorize');

  for (const slug of ['google-docs', 'google-calendar', 'google-sheets', 'google-gmail', 'google-slides', 'google-drive']) {
    it(`keeps ${slug} eligible even when the stored token looks healthy`, () => {
      // The invalid_grant case: refresh_token present but revoked upstream.
      // Nothing in the stored record can reveal that, so the button must not
      // be gated on the record looking broken.
      const instance = { mcpSlug: slug, provider: 'google', tokenStatus: { hasRefreshToken: true, isExpired: false } };
      assert.equal(canReauthorize(instance, { oauthAuthorizationUrl: null }), true);
    });
  }

  it('treats a missing provider as Google, since that is the legacy default', () => {
    assert.equal(canReauthorize({ mcpSlug: 'google-docs' }, null), true);
  });

  it('offers reconnect for OAuth-based non-Google providers', () => {
    for (const provider of ['clickup', 'slack', 'hubspot', 'outline']) {
      assert.equal(canReauthorize({ provider }, OAUTH_MCP), true, `${provider} should be re-authorizable`);
    }
  });

  it('does NOT offer reconnect for paste-token providers', () => {
    // /connect/:slug rejects these with "uses direct token authentication",
    // so a button here would be a dead end. They re-authenticate by pasting a
    // new token, not by an OAuth round-trip — see reauthAffordance below.
    for (const provider of ['slack-bot', 'peopleforce']) {
      assert.equal(canReauthorize({ provider }, PASTE_MCP), false, `${provider} has no authorize endpoint`);
    }
  });

  it('follows the catalog for Outline, which is OAuth or paste depending on env', () => {
    assert.equal(canReauthorize({ provider: 'outline' }, OAUTH_MCP), true);
    assert.equal(canReauthorize({ provider: 'outline' }, PASTE_MCP), false);
  });

  it('does not throw when the catalog entry is missing entirely', () => {
    assert.equal(canReauthorize({ provider: 'clickup' }, undefined), false);
    assert.equal(canReauthorize({ provider: 'clickup' }, null), false);
  });
});

describe('dashboard needsReauthNow()', () => {
  const gate = (verdicts: Record<string, string>) => build<(i: any, m: any) => boolean>(
    verdicts,
    ['canReauthorize(instance, mcp)', 'healthSaysReauth(instance)', 'needsReauthNow(instance, mcp)'],
    'needsReauthNow',
  );

  const gmail = { instanceId: 'i1', mcpSlug: 'google-gmail', provider: 'google' };

  it('shows the button before any verdict arrives', () => {
    // The row renders before the probe returns, and the probe may never return
    // at all. Waiting on it is what left users with no repair to reach.
    assert.equal(gate({})(gmail, null), true);
  });

  it('keeps showing it on a healthy connection', () => {
    // A catalog scope the stored token predates probes as 'healthy': every old
    // tool still works and only the new ones 403. Re-consent is the fix, and
    // the user must be able to reach it without proving anything is broken.
    assert.equal(gate({ i1: 'healthy' })(gmail, null), true);
  });

  it('keeps showing it when the provider could not be reached', () => {
    assert.equal(gate({ i1: 'unknown' })(gmail, null), true);
  });

  it('shows it on a reauth verdict', () => {
    assert.equal(gate({ i1: 'reauth' })(gmail, null), true);
  });

  it('never shows for a provider that cannot re-consent, even on a reauth verdict', () => {
    const pf = { instanceId: 'i1', mcpSlug: 'peopleforce', provider: 'peopleforce' };
    assert.equal(gate({ i1: 'reauth' })(pf, { oauthAuthorizationUrl: '' }), false);
  });
});

// The probe's only remaining job: emphasis. It must never be the difference
// between a button and no button.
describe('dashboard reauthNeedsAttention()', () => {
  const attention = (verdicts: Record<string, string>) => build<(i: any) => boolean>(
    verdicts,
    ['healthSaysReauth(instance)', 'needsReconnect(instance)', 'reauthNeedsAttention(instance)'],
    'reauthNeedsAttention',
  );

  const gmail = { instanceId: 'i1', mcpSlug: 'google-gmail', provider: 'google' };

  it('stays quiet with no verdict and a healthy stored token', () => {
    const healthy = { ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: false } };
    assert.equal(attention({})(healthy), false);
  });

  it('stays quiet on a healthy or unreachable verdict', () => {
    assert.equal(attention({ i1: 'healthy' })({ ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: false } }), false);
    assert.equal(attention({ i1: 'unknown' })({ ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: false } }), false);
  });

  it('highlights on a live reauth verdict', () => {
    assert.equal(attention({ i1: 'reauth' })({ ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: false } }), true);
  });

  it('highlights an expired or refresh-less Google token without waiting for a probe', () => {
    assert.equal(attention({})({ ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: true } }), true);
    assert.equal(attention({})({ ...gmail, tokenStatus: { hasRefreshToken: false, isExpired: false } }), true);
  });

  it('ignores stored expiry for non-Google providers, whose tokens are long-lived', () => {
    const slack = { instanceId: 'i1', provider: 'slack', tokenStatus: { hasRefreshToken: false, isExpired: true } };
    assert.equal(attention({})(slack), false);
    assert.equal(attention({ i1: 'reauth' })(slack), true);
  });

  it('scopes verdicts to their own instance', () => {
    const other = { instanceId: 'i2', mcpSlug: 'google-gmail', provider: 'google', tokenStatus: { hasRefreshToken: true, isExpired: false } };
    const check = attention({ i1: 'reauth' });
    assert.equal(check({ ...gmail, tokenStatus: { hasRefreshToken: true, isExpired: false } }), true);
    assert.equal(check(other), false);
  });
});

describe('dashboard reauthAffordance()', () => {
  const affordance = (verdicts: Record<string, string>) => build<(i: any, m: any) => string>(
    verdicts,
    ['canReauthorize(instance, mcp)', 'healthSaysReauth(instance)', 'needsReauthNow(instance, mcp)',
     'usesPastedToken(instance, mcp)', 'reauthAffordance(instance, mcp)'],
    'reauthAffordance',
  );

  const pf = { instanceId: 'i1', mcpSlug: 'peopleforce', provider: 'peopleforce' };
  const bot = { instanceId: 'i1', mcpSlug: 'slack-bot', provider: 'slack-bot' };
  const gmail = { instanceId: 'i1', mcpSlug: 'google-gmail', provider: 'google' };
  const slack = { instanceId: 'i1', mcpSlug: 'slack', provider: 'slack' };

  it('offers Re-enter token to a paste-token row whatever the probe says', () => {
    for (const verdict of VERDICTS) {
      assert.equal(affordance(verdict)(pf, PASTE_MCP), 'reenter');
      assert.equal(affordance(verdict)(bot, PASTE_MCP), 'reenter');
    }
  });

  it('offers Reconnect, not Re-enter, for an OAuth connection', () => {
    for (const verdict of VERDICTS) {
      assert.equal(affordance(verdict)(gmail, null), 'reconnect');
      assert.equal(affordance(verdict)(slack, OAUTH_MCP), 'reconnect');
    }
  });

  it('offers nothing only when neither repair exists', () => {
    // No catalog entry means no authorize URL to send them to and no token
    // form to point at, so a button would dead-end.
    assert.equal(affordance({ i1: 'reauth' })({ instanceId: 'i1', provider: 'clickup' }, undefined), 'none');
  });

  it('never offers both at once', () => {
    for (const verdict of ['healthy', 'unknown', 'reauth']) {
      for (const [instance, mcp] of [[pf, PASTE_MCP], [gmail, null], [bot, PASTE_MCP], [slack, OAUTH_MCP]] as const) {
        const result = affordance({ i1: verdict })(instance, mcp);
        assert.ok(['none', 'reconnect', 'reenter'].includes(result));
      }
    }
  });
});
