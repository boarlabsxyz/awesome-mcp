import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { resolveTeamNames, formatTeamLabel, clearTeamNameCache } from '../../slack-user/teamNames.js';

function client(map: Record<string, string>, onCall?: (id: string) => void) {
  return {
    teamInfo: async (teamId?: string) => {
      onCall?.(teamId!);
      const name = map[teamId!];
      // team.info on a foreign org fails — the normal case for Slack Connect.
      if (!name) throw new Error('team_not_found');
      return { team: { name } };
    },
  };
}

describe('resolveTeamNames', () => {
  beforeEach(() => clearTeamNameCache());

  it('resolves what it can and omits what it cannot', async () => {
    const { names } = await resolveTeamNames(client({ T_A: 'Acme' }), ['T_A', 'T_FOREIGN']);
    assert.equal(names.get('T_A'), 'Acme');
    assert.equal(names.has('T_FOREIGN'), false);
  });

  it('never throws when every lookup fails', async () => {
    const boom = { teamInfo: async () => { throw new Error('nope'); } };
    const { names } = await resolveTeamNames(boom, ['T_X']);
    assert.equal(names.size, 0);
  });

  it('de-duplicates and skips empty IDs', async () => {
    const calls: string[] = [];
    await resolveTeamNames(client({ T_A: 'Acme' }, id => calls.push(id)), ['T_A', 'T_A', '']);
    assert.deepEqual(calls, ['T_A']);
  });

  it('reports truncation instead of silently shortening', async () => {
    const res = await resolveTeamNames(client({ T1: 'a', T2: 'b', T3: 'c' }), ['T1', 'T2', 'T3'], { max: 2 });
    assert.equal(res.truncated, true);
    assert.match(res.note!, /first 2 organisations/);
    assert.equal(res.names.size, 2);
  });

  it('does not report truncation when everything fits', async () => {
    const res = await resolveTeamNames(client({ T1: 'a' }), ['T1'], { max: 5 });
    assert.equal(res.truncated, false);
    assert.equal(res.note, undefined);
  });

  it('bypasses the cache entirely when no tokenKey is given', async () => {
    // Without this, two callers with different tokens would share results —
    // and whether team.info succeeds depends on the calling token.
    const calls: string[] = [];
    const c = client({ T_A: 'Acme' }, id => calls.push(id));
    await resolveTeamNames(c, ['T_A']);
    await resolveTeamNames(c, ['T_A']);
    assert.deepEqual(calls, ['T_A', 'T_A'], 'expected no caching without a tokenKey');
  });

  it('caches per token, and does not serve one token\'s names to another', async () => {
    const calls: string[] = [];
    const first = client({ T_A: 'Acme' }, id => calls.push(id));
    await resolveTeamNames(first, ['T_A'], { tokenKey: 'tok1' });
    await resolveTeamNames(first, ['T_A'], { tokenKey: 'tok1' });
    assert.equal(calls.length, 1, 'second call for the same token should be cached');

    // A different token must not inherit tok1's answer.
    const second = client({ T_A: 'Different Corp' }, id => calls.push(id));
    const { names } = await resolveTeamNames(second, ['T_A'], { tokenKey: 'tok2' });
    assert.equal(names.get('T_A'), 'Different Corp');
    assert.equal(calls.length, 2);
  });

  it('caches failures too, so a denied org is not retried on every access check', async () => {
    const calls: string[] = [];
    const c = client({}, id => calls.push(id));
    await resolveTeamNames(c, ['T_FOREIGN'], { tokenKey: 'tok' });
    await resolveTeamNames(c, ['T_FOREIGN'], { tokenKey: 'tok' });
    assert.equal(calls.length, 1);
  });
});

describe('formatTeamLabel', () => {
  it('keeps the ID even when a name is known', () => {
    // The dashboard labels unresolved orgs by raw ID, so the ID is what lets a
    // user match an error message to the checkbox they have to tick.
    assert.equal(formatTeamLabel('T123', new Map([['T123', 'Acme']])), 'Acme (T123)');
  });

  it('falls back to the bare ID', () => {
    assert.equal(formatTeamLabel('T123', new Map()), 'T123');
    assert.equal(formatTeamLabel('T123'), 'T123');
  });
});
