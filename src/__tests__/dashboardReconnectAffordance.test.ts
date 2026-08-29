import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard's reconnect affordance has silently regressed twice, both
// times because it is inline browser JS with no test boundary:
//
//   1. needsReconnect() returned false for every non-Google provider, so a
//      Slack row never offered Reconnect while the tools were telling the user
//      to "reconnect from the dashboard to re-consent".
//   2. The replacement only covered non-Google providers, leaving Google MCPs
//      with a revoked-but-present refresh token showing no button at all —
//      computeTokenStatus reports isExpired=false whenever a refresh_token
//      exists, so a dead Gmail connection rendered as perfectly healthy.
//
// This lifts the predicate out of dashboard.html and exercises it directly, so
// a third regression fails here instead of in someone's browser.

const dashboardPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'dashboard.html',
);

function loadCanReauthorize(): (instance: any, mcp: any) => boolean {
  const html = fs.readFileSync(dashboardPath, 'utf8');
  const match = html.match(/function canReauthorize\(instance, mcp\) \{[\s\S]*?\n {4}\}/);
  assert.ok(match, 'canReauthorize() not found in dashboard.html — was it renamed?');
  return new Function(`${match[0]}; return canReauthorize;`)() as any;
}

const OAUTH_MCP = { oauthAuthorizationUrl: 'https://app.clickup.com/api' };
const PASTE_MCP = { oauthAuthorizationUrl: '' };

// NOTE: canReauthorize() is now a PRE-FILTER, not the button gate. It answers
// "could re-consent even work here", and needsReauthNow() then requires a live
// 'reauth' verdict from /api/me/connections/:id/health before any button is
// drawn. These tests still pin the pre-filter: a provider wrongly excluded here
// can never show the button no matter what the probe says.
describe('dashboard canReauthorize()', () => {
  const canReauthorize = loadCanReauthorize();

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
    // new token, not by an OAuth round-trip.
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

// The button gate itself. Extracted like canReauthorize, for the same reason:
// this logic has regressed every time it lived only in an inline script.
describe('dashboard needsReauthNow()', () => {
  const html = fs.readFileSync(dashboardPath, 'utf8');
  const canSrc = html.match(/function canReauthorize\(instance, mcp\) \{[\s\S]*?\n {4}\}/);
  const gateSrc = html.match(/function needsReauthNow\(instance, mcp\) \{[\s\S]*?\n {4}\}/);
  assert.ok(canSrc && gateSrc, 'button-gate functions not found in dashboard.html');

  // connectionHealth is a module-level Map in the page; recreate the closure.
  const healthSrc = html.match(/function healthSaysReauth\(instance\) \{[\s\S]*?\n {4}\}/);
  assert.ok(healthSrc, 'healthSaysReauth() not found in dashboard.html');

  const build = (verdicts: Record<string, string>) =>
    new Function(`
      const connectionHealth = new Map(Object.entries(${JSON.stringify(verdicts)}));
      ${canSrc[0]}
      ${healthSrc[0]}
      ${gateSrc[0]}
      return needsReauthNow;
    `)() as (i: any, m: any) => boolean;

  const gmail = { instanceId: 'i1', mcpSlug: 'google-gmail', provider: 'google' };

  it('shows nothing until a verdict arrives', () => {
    // The row renders before the probe returns. A healthy connection must
    // never flash a warning button in that window.
    assert.equal(build({})(gmail, null), false);
  });

  it('shows the button only on a reauth verdict', () => {
    assert.equal(build({ i1: 'reauth' })(gmail, null), true);
  });

  it('hides it again once the connection is healthy', () => {
    // The reported complaint: it stayed visible after reconnecting.
    assert.equal(build({ i1: 'healthy' })(gmail, null), false);
  });

  it('stays hidden when the provider could not be reached', () => {
    // An unreachable provider is not evidence the user must reconnect.
    assert.equal(build({ i1: 'unknown' })(gmail, null), false);
  });

  it('never shows for a provider that cannot re-consent, even on a reauth verdict', () => {
    const pf = { instanceId: 'i1', mcpSlug: 'peopleforce', provider: 'peopleforce' };
    assert.equal(build({ i1: 'reauth' })(pf, { oauthAuthorizationUrl: '' }), false);
  });

  it('scopes verdicts to their own instance', () => {
    const other = { instanceId: 'i2', mcpSlug: 'google-gmail', provider: 'google' };
    const gate = build({ i1: 'reauth' });
    assert.equal(gate(gmail, null), true);
    assert.equal(gate(other, null), false);
  });
});

// Both repair affordances must answer to the same probe. Paste-token rows were
// ungated, so PeopleForce and Slack-bot kept the permanent amber button this
// change removes everywhere else — the same bug wearing a different label.
describe('dashboard reauthAffordance()', () => {
  const html = fs.readFileSync(dashboardPath, 'utf8');
  const parts = ['canReauthorize\\(instance, mcp\\)', 'usesPastedToken\\(instance, mcp\\)',
                 'healthSaysReauth\\(instance\\)', 'needsReauthNow\\(instance, mcp\\)',
                 'reauthAffordance\\(instance, mcp\\)']
    .map(sig => {
      const m = html.match(new RegExp(`function ${sig} \\{[\\s\\S]*?\\n {4}\\}`));
      assert.ok(m, `${sig} not found in dashboard.html`);
      return m[0];
    });

  const build = (verdicts: Record<string, string>) =>
    new Function(`
      const connectionHealth = new Map(Object.entries(${JSON.stringify(verdicts)}));
      ${parts.join('\n')}
      return reauthAffordance;
    `)() as (i: any, m: any) => string;

  const pf = { instanceId: 'i1', mcpSlug: 'peopleforce', provider: 'peopleforce' };
  const bot = { instanceId: 'i1', mcpSlug: 'slack-bot', provider: 'slack-bot' };
  const gmail = { instanceId: 'i1', mcpSlug: 'google-gmail', provider: 'google' };

  it('offers nothing to a healthy paste-token row', () => {
    assert.equal(build({ i1: 'healthy' })(pf, PASTE_MCP), 'none');
  });

  it('offers nothing to a paste-token row before a verdict arrives', () => {
    assert.equal(build({})(bot, PASTE_MCP), 'none');
  });

  it('offers nothing when the provider could not be reached', () => {
    assert.equal(build({ i1: 'unknown' })(pf, PASTE_MCP), 'none');
  });

  it('offers Re-enter token only once a paste-token credential is rejected', () => {
    assert.equal(build({ i1: 'reauth' })(pf, PASTE_MCP), 'reenter');
    assert.equal(build({ i1: 'reauth' })(bot, PASTE_MCP), 'reenter');
  });

  it('offers Reconnect, not Re-enter, for an OAuth connection', () => {
    assert.equal(build({ i1: 'reauth' })(gmail, null), 'reconnect');
  });

  it('never offers both at once', () => {
    for (const verdict of ['healthy', 'unknown', 'reauth']) {
      for (const [instance, mcp] of [[pf, PASTE_MCP], [gmail, null], [bot, PASTE_MCP]] as const) {
        const result = build({ i1: verdict })(instance, mcp);
        assert.ok(['none', 'reconnect', 'reenter'].includes(result));
      }
    }
  });
});
