import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PINECONE_WRITE_TOOLS,
  PineconeAccessDenied,
  type PineconeRulesState,
  assertIndexAllowed,
  assertNamespaceAllowed,
  assertTargetsAllowed,
  assertWriteAllowed,
  describeNamespace,
  describeRules,
  filterIndexRows,
  filterNamespaceStats,
  hasIndexRules,
  hasNamespaceRules,
  indexMatchesPattern,
  namespaceMatchesPattern,
  toIndexList,
  toNamespaceList,
  validateIndexPattern,
  validateNamespacePattern,
} from '../../pinecone/accessRules.js';

const loaded = (rules?: any): PineconeRulesState => ({ status: 'loaded', rules });
const unavailable: PineconeRulesState = { status: 'unavailable', detail: 'db down' };

/** assert.throws returns undefined, so capture the error to inspect its fields. */
function denial(fn: () => void): PineconeAccessDenied {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PineconeAccessDenied, `expected PineconeAccessDenied, got ${err}`);
    return err as PineconeAccessDenied;
  }
  throw new assert.AssertionError({ message: 'expected PineconeAccessDenied, nothing was thrown' });
}

describe('indexMatchesPattern', () => {
  it('matches exactly, case-insensitively', () => {
    assert.equal(indexMatchesPattern('docs', 'docs'), true);
    assert.equal(indexMatchesPattern('Docs', 'docs'), true);
    assert.equal(indexMatchesPattern(' docs ', 'docs'), true);
  });

  it('does NOT suffix-match — the trap a hostname matcher would fall into', () => {
    // `prod` must not match `not-prod`: an index name is a flat token with no
    // separator to anchor a suffix rule to.
    assert.equal(indexMatchesPattern('prod', 'not-prod'), false);
    assert.equal(indexMatchesPattern('prod', 'prod-v2'), false);
  });
});

describe('namespaceMatchesPattern', () => {
  it('is case-SENSITIVE, unlike the index matcher', () => {
    assert.equal(namespaceMatchesPattern('Prod', 'prod'), false);
    assert.equal(namespaceMatchesPattern('prod', 'prod'), true);
  });

  it('treats the empty string as a real namespace', () => {
    assert.equal(namespaceMatchesPattern('', ''), true);
    assert.equal(namespaceMatchesPattern('', 'hr'), false);
  });
});

describe('toNamespaceList', () => {
  it('PRESERVES the empty string — the default namespace', () => {
    // The whole point: a blank-dropping normaliser would silently delete the
    // user's default-namespace rule on every save.
    assert.deepEqual(toNamespaceList(['', 'hr']), ['', 'hr']);
  });

  it('de-duplicates but keeps order', () => {
    assert.deepEqual(toNamespaceList(['hr', 'hr', '']), ['hr', '']);
  });

  it('is not a list when given a non-array', () => {
    assert.deepEqual(toNamespaceList('hr'), []);
    assert.deepEqual(toNamespaceList(undefined), []);
  });

  it('drops null and undefined entries but not the empty string', () => {
    assert.deepEqual(toNamespaceList(['', null, undefined, 'a']), ['', 'a']);
  });
});

describe('toIndexList', () => {
  it('drops blanks and lowercases, unlike the namespace list', () => {
    assert.deepEqual(toIndexList([' Docs ', '', '  ', 'docs']), ['docs']);
  });
});

describe('validateIndexPattern', () => {
  it('accepts a plain lowercase name', () => {
    assert.equal(validateIndexPattern('company-docs'), null);
  });

  it('refuses a wildcard rather than widening a rule', () => {
    assert.match(String(validateIndexPattern('prod-*')), /wildcard/);
  });

  it('explains uppercase rather than silently lowercasing it', () => {
    // Pinecone stores names lowercase, so an uppercase rule can never match —
    // accepting it would save a rule that does nothing.
    assert.match(String(validateIndexPattern('Docs')), /lowercase/);
  });

  it('refuses an over-long or malformed name', () => {
    assert.ok(validateIndexPattern('x'.repeat(46)));
    assert.ok(validateIndexPattern('-leading-hyphen'));
    assert.ok(validateIndexPattern(''));
  });
});

describe('validateNamespacePattern', () => {
  it('accepts the empty string — it is the default namespace', () => {
    assert.equal(validateNamespacePattern(''), null);
  });

  it('refuses whitespace-only, which is a different thing entirely', () => {
    assert.match(String(validateNamespacePattern('   ')), /default namespace/);
  });
});

describe('assertIndexAllowed', () => {
  it('allows anything when no rules are configured', () => {
    assert.doesNotThrow(() => assertIndexAllowed(loaded(undefined), 'anything'));
    assert.doesNotThrow(() => assertIndexAllowed(loaded({}), 'anything'));
  });

  it('refuses a name off the allowlist and names the allowed ones', () => {
    const err = denial(() => assertIndexAllowed(loaded({ allowedIndexes: ['a', 'b'] }), 'c'));
    assert.equal(err.reason, 'index-allowlist-miss');
    assert.match(err.message, /a, b/);
    // Must not let the denial double as proof the index exists.
    assert.match(err.message, /does not tell you whether an index of that name exists/);
  });

  it('lets the blocklist outrank the allowlist', () => {
    const err = denial(() => assertIndexAllowed(loaded({ allowedIndexes: ['a'], blockedIndexes: ['a'] }), 'a'));
    assert.equal(err.reason, 'index-blocklist-hit');
  });

  it('FAILS OPEN when the rules could not be read', () => {
    // Safe only because both write tools gate on assertWriteAllowed first.
    assert.doesNotThrow(() => assertIndexAllowed(unavailable, 'anything'));
  });

  it("tells a create to add the name to the allowlist first", () => {
    const err = denial(() => assertIndexAllowed(loaded({ allowedIndexes: ['a'] }), 'new', { intent: 'create' }));
    assert.match(err.message, /denies nothing/);
  });
});

describe('assertNamespaceAllowed', () => {
  it('allows the default namespace when "" is on the allowlist', () => {
    assert.doesNotThrow(() => assertNamespaceAllowed(loaded({ allowedNamespaces: [''] }), 'idx', ''));
  });

  it('refuses the default namespace when the allowlist names only others', () => {
    const err = denial(() => assertNamespaceAllowed(loaded({ allowedNamespaces: ['hr'] }), 'idx', ''));
    assert.equal(err.reason, 'namespace-allowlist-miss');
    assert.match(err.message, /\(default namespace\)/);
  });

  it('says the rule is not index-specific, since the list is flat', () => {
    const err = denial(() => assertNamespaceAllowed(loaded({ allowedNamespaces: ['hr'] }), 'idx', 'eng'));
    assert.match(err.message, /across every allowed index/);
  });

  it('fails open when the rules could not be read', () => {
    assert.doesNotThrow(() => assertNamespaceAllowed(unavailable, 'idx', 'eng'));
  });
});

describe('assertWriteAllowed', () => {
  it('allows a write when read-only is off or unset', () => {
    assert.doesNotThrow(() => assertWriteAllowed(loaded(undefined), 'upsert-records'));
    assert.doesNotThrow(() => assertWriteAllowed(loaded({ readOnly: false }), 'upsert-records'));
  });

  it('refuses a write when read-only is on', () => {
    const err = denial(() => assertWriteAllowed(loaded({ readOnly: true }), 'upsert-records'));
    assert.equal(err.reason, 'read-only');
  });

  it('FAILS CLOSED when the rules could not be read — the opposite of the read paths', () => {
    const err = denial(() => assertWriteAllowed(unavailable, 'upsert-records'));
    assert.equal(err.reason, 'rules-unavailable');
  });

  it('does not let a transient failure read as a configured restriction', () => {
    const err = denial(() => assertWriteAllowed(unavailable, 'upsert-records'));
    assert.match(err.message, /temporary failure, not a configured restriction/);
    assert.match(err.message, /db down/);
  });

  it('names both write tools, so a third one added without a gate is caught', () => {
    assert.deepEqual([...PINECONE_WRITE_TOOLS], ['create-index-for-model', 'upsert-records']);
  });
});

describe('assertTargetsAllowed', () => {
  const rules = loaded({ allowedIndexes: ['a', 'b'], allowedNamespaces: ['hr'] });

  it('passes when every target is allowed', () => {
    assert.doesNotThrow(() =>
      assertTargetsAllowed(rules, [
        { index: 'a', namespace: 'hr' },
        { index: 'b', namespace: 'hr' },
      ]),
    );
  });

  it('refuses the WHOLE call when one target is denied', () => {
    const err = denial(() => assertTargetsAllowed(rules, [
          { index: 'a', namespace: 'hr' },
          { index: 'c', namespace: 'hr' },
        ]));
    assert.equal(err.deniedTargets?.length, 1);
    assert.equal(err.deniedTargets?.[0].index, 'c');
    // The reasoning has to reach the model, or it will retry the same call.
    assert.match(err.message, /one ranking fused across every index/);
  });

  it('collects every denial rather than reporting them one per round trip', () => {
    const err = denial(() => assertTargetsAllowed(rules, [
          { index: 'c', namespace: 'hr' },
          { index: 'd', namespace: 'hr' },
          { index: 'a', namespace: 'eng' },
        ]));
    assert.equal(err.deniedTargets?.length, 3);
  });
});

describe('filterIndexRows', () => {
  it('returns everything untouched when no index rules exist', () => {
    const rows = [{ name: 'a' }, { name: 'b' }];
    const out = filterIndexRows(loaded(undefined), rows);
    assert.deepEqual(out.visible, rows);
    assert.equal(out.hiddenCount, 0);
    assert.equal(out.note, undefined);
  });

  it('hides denied rows AND states that they exist', () => {
    const out = filterIndexRows(loaded({ allowedIndexes: ['a'] }), [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    assert.deepEqual(out.visible.map(r => r.name), ['a']);
    assert.equal(out.hiddenCount, 2);
    // Closing the Slack trap: hidden must never read as nonexistent.
    assert.match(String(out.note), /They exist; this connection cannot use them/);
  });
});

describe('filterNamespaceStats', () => {
  it('explains why the visible counts will not sum to the total', () => {
    const out = filterNamespaceStats(loaded({ allowedNamespaces: ['hr'] }), {
      hr: { recordCount: 3 },
      eng: { recordCount: 9 },
    });
    assert.deepEqual(Object.keys(out.visible), ['hr']);
    assert.equal(out.hiddenCount, 1);
    assert.match(String(out.note), /do not sum to the total/);
  });

  it('keeps the default namespace when it is allowed', () => {
    const out = filterNamespaceStats(loaded({ allowedNamespaces: [''] }), {
      '': { recordCount: 2 },
      hr: { recordCount: 3 },
    });
    assert.deepEqual(Object.keys(out.visible), ['']);
  });
});

describe('describeRules / describeNamespace', () => {
  it('returns undefined when nothing is configured', () => {
    assert.equal(describeRules(undefined), undefined);
    assert.equal(describeRules({}), undefined);
    assert.equal(describeRules({ readOnly: false }), undefined);
  });

  it('renders the default namespace by name, not as an empty string', () => {
    assert.equal(describeNamespace(''), '(default namespace)');
    const line = String(describeRules({ allowedNamespaces: [''] }));
    assert.match(line, /\(default namespace\)/);
    assert.match(line, /across every allowed index/);
  });

  it('says read-only names the two refused tools', () => {
    assert.match(String(describeRules({ readOnly: true })), /create-index-for-model and upsert-records/);
  });

  it('states that the rules do not limit the API key', () => {
    assert.match(String(describeRules({ allowedIndexes: ['a'] })), /do not limit the API key itself/);
  });
});

describe('hasIndexRules / hasNamespaceRules', () => {
  it('ignore readOnly, which is neither', () => {
    assert.equal(hasIndexRules({ readOnly: true }), false);
    assert.equal(hasNamespaceRules({ readOnly: true }), false);
  });

  it('count the empty-string namespace as a real rule', () => {
    assert.equal(hasNamespaceRules({ allowedNamespaces: [''] }), true);
  });
});
