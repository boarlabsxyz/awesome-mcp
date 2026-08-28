import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paste-token providers (slack-bot, peopleforce, hubspot-by-token, and Outline
// in paste mode) had no way to replace a rotated credential: every branch of
// /api/connect-token called createMcpInstance unconditionally, so re-pasting
// produced a DUPLICATE connection and left the dead one in place.
//
// Delete-and-re-add was the only real option and is not equivalent — the MCP
// URL embeds instanceId (as `apiKey.instanceId` or `?instanceId=`), so
// recreating hands back a different URL and the connector has to be re-added
// in Claude. OAuth providers get in-place repair via /connect/:slug?reconnect=;
// this is the paste-token counterpart.

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dashboardPath = path.join(repoRoot, 'public', 'dashboard.html');
const webServerPath = path.join(repoRoot, 'src', 'website', 'webServer.ts');

function loadUsesPastedToken(): (instance: any, mcp: any) => boolean {
  const html = fs.readFileSync(dashboardPath, 'utf8');
  const match = html.match(/function usesPastedToken\(instance, mcp\) \{[\s\S]*?\n {4}\}/);
  assert.ok(match, 'usesPastedToken() not found in dashboard.html — was it renamed?');
  return new Function(`${match[0]}; return usesPastedToken;`)() as any;
}

const OAUTH_MCP = { oauthAuthorizationUrl: 'https://app.hubspot.com/oauth/authorize' };
const PASTE_MCP = { oauthAuthorizationUrl: '' };

describe('dashboard usesPastedToken()', () => {
  const usesPastedToken = loadUsesPastedToken();

  it('offers the token form to providers that authenticate by paste', () => {
    for (const provider of ['slack-bot', 'peopleforce']) {
      assert.equal(usesPastedToken({ provider }, PASTE_MCP), true, `${provider} pastes a token`);
    }
  });

  it('does not offer it to OAuth connections, which reconnect instead', () => {
    // Two affordances for one connection would be a coin flip for the user.
    for (const provider of ['clickup', 'slack', 'hubspot']) {
      assert.equal(usesPastedToken({ provider }, OAUTH_MCP), false, `${provider} uses OAuth here`);
    }
  });

  it('follows the catalog for Outline, which is dual-mode', () => {
    // Same provider, opposite answer, decided by whether the deployment set
    // OUTLINE_CLIENT_ID/SECRET/BASE_URL.
    assert.equal(usesPastedToken({ provider: 'outline' }, PASTE_MCP), true);
    assert.equal(usesPastedToken({ provider: 'outline' }, OAUTH_MCP), false);
  });

  it('never offers it to Google connections', () => {
    assert.equal(usesPastedToken({ provider: 'google' }, PASTE_MCP), false);
    assert.equal(usesPastedToken({}, PASTE_MCP), false);
  });

  it('does not throw when the catalog entry is missing', () => {
    assert.equal(usesPastedToken({ provider: 'peopleforce' }, undefined), false);
    assert.equal(usesPastedToken({ provider: 'peopleforce' }, null), false);
  });
});

// The server half is a long inline Express handler with no seam to import, so
// these assert the shape that makes in-place repair possible at all. They are
// coarse on purpose: they catch a regression that reverts any branch to an
// unconditional create, which is exactly how this bug existed.
describe('/api/connect-token supports in-place re-authentication', () => {
  const source = fs.readFileSync(webServerPath, 'utf8');
  const start = source.indexOf("app.post('/api/connect-token'");
  assert.notEqual(start, -1, '/api/connect-token handler not found');
  // Bound the slice at the handler's own final fallthrough, so a
  // persistPasteConnection call somewhere else in this 5k-line file cannot
  // make these assertions pass by accident.
  const endMarker = 'Direct token connection not supported';
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'handler end marker not found — did the fallthrough change?');
  const handler = source.slice(start, end);

  it('accepts instanceId from the request body', () => {
    assert.match(handler, /const \{ mcpSlug, token, instanceName, instanceId \}/);
  });

  it('routes every paste provider through the shared persist helper', () => {
    // slack-bot and outline build their own names/emails but must not keep
    // their own create call, or they silently lose re-auth again.
    const calls = handler.match(/persistPasteConnection\(\{/g) || [];
    assert.ok(calls.length >= 3, `expected every paste branch to delegate, found ${calls.length}`);
  });

  it('verifies ownership and slug before writing to a named instance', () => {
    // Without this an instanceId from another account would be writable.
    assert.match(
      handler,
      /existing\.userId !== userId \|\| existing\.mcpSlug !== mcpSlug/,
    );
  });

  it('updates in place rather than creating when instanceId is present', () => {
    assert.match(handler, /if \(instanceId\)[\s\S]{0,600}updateMcpInstanceProviderTokens/);
  });

  it('reports the reauthenticated case distinctly from a fresh connect', () => {
    assert.match(handler, /reauthenticated: true/);
  });
});
