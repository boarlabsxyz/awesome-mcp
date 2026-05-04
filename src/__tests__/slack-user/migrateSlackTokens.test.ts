import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateSlackTokens } from '../../mcpConnectionStore.js';

describe('migrateSlackTokens', () => {
  it('should return tokens unchanged if accessRules already exists', () => {
    const tokens = {
      access_token: 'xoxp-123',
      accessRules: {
        allowedOrgs: ['T1'],
        blacklistUsers: ['U1'],
        whitelistChannels: ['*'],
        blacklistChannels: [],
        allowPublicOnly: false,
      },
    };
    const result = migrateSlackTokens(tokens);
    assert.deepEqual(result, tokens);
  });

  it('should migrate legacy tokens with allowedChannels to empty accessRules', () => {
    const tokens = {
      access_token: 'xoxp-456',
      allowedChannels: ['C1', 'C2'],
    };
    const result = migrateSlackTokens(tokens);
    assert.equal(result.access_token, 'xoxp-456');
    assert.deepEqual(result.accessRules, {
      allowedOrgs: [],
      blacklistUsers: [],
      whitelistChannels: [],
      blacklistChannels: [],
      allowPublicOnly: false,
    });
    assert.deepEqual(result.allowedChannels, ['C1', 'C2']);
  });

  it('should migrate tokens with no allowedChannels', () => {
    const tokens = { access_token: 'xoxp-789' };
    const result = migrateSlackTokens(tokens);
    assert.equal(result.access_token, 'xoxp-789');
    assert.ok(result.accessRules);
    assert.deepEqual(result.allowedChannels, []);
  });
});
