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

describe('dashboard canReauthorize()', () => {
  const canReauthorize = loadCanReauthorize();

  for (const slug of ['google-docs', 'google-calendar', 'google-sheets', 'google-gmail', 'google-slides', 'google-drive']) {
    it(`offers reconnect for ${slug} even when the stored token looks healthy`, () => {
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
