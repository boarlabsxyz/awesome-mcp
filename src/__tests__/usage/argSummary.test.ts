import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  summarizeArgs,
  summarizeError,
  redactSecrets,
  redactAndTruncate,
  PREVIEW_MAX_CHARS,
  ERROR_MESSAGE_MAX_CHARS,
} from '../../usage/argSummary.js';

describe('summarizeArgs', () => {
  it('keeps every key name but values only for allowlisted keys', () => {
    const s = summarizeArgs({
      documentId: 'doc-123',
      query: 'quarterly report',
      text: 'the full body of a private document',
      firstName: 'Ada',
    });
    assert.deepEqual(s.argKeys, ['documentId', 'query', 'text', 'firstName']);
    assert.deepEqual(s.argPreview, { query: 'quarterly report' });
  });

  it('returns a null preview when no allowlisted key is present', () => {
    const s = summarizeArgs({ documentId: 'doc-123', text: 'body' });
    assert.equal(s.argPreview, null);
  });

  it('omits keys whose value is undefined', () => {
    const s = summarizeArgs({ query: 'x', tabId: undefined });
    assert.deepEqual(s.argKeys, ['query']);
  });

  it('collapses arrays and objects to their type and size, never their contents', () => {
    const s = summarizeArgs({ name: ['secret a', 'secret b'], title: { nested: 'secret' } });
    assert.deepEqual(s.argPreview, {
      name: { type: 'array', length: 2 },
      title: { type: 'object', length: 1 },
    });
    assert.doesNotMatch(JSON.stringify(s.argPreview), /secret/);
  });

  it('keeps numbers, booleans and null as-is', () => {
    const s = summarizeArgs({ search: 42, pattern: true, query: null });
    assert.deepEqual(s.argPreview, { search: 42, pattern: true, query: null });
  });

  it('truncates long values without splitting a surrogate pair', () => {
    const value = 'a'.repeat(PREVIEW_MAX_CHARS - 1) + '😀' + 'tail';
    const preview = summarizeArgs({ query: value }).argPreview!.query as string;
    assert.ok(preview.length <= PREVIEW_MAX_CHARS);
    assert.equal(preview, 'a'.repeat(PREVIEW_MAX_CHARS - 1));
    assert.doesNotThrow(() => encodeURIComponent(preview));
  });

  it('measures the whole call in UTF-8 bytes', () => {
    const s = summarizeArgs({ text: '😀😀' });
    assert.equal(s.argBytes, Buffer.byteLength(JSON.stringify({ text: '😀😀' }), 'utf8'));
  });

  it('reports a null size for args that cannot be serialised, and still summarises them', () => {
    const args: any = { query: 'x' };
    args.self = args;
    const s = summarizeArgs(args);
    assert.equal(s.argBytes, null);
    assert.deepEqual(s.argPreview, { query: 'x' });
  });

  it('returns an empty summary for non-object args', () => {
    for (const v of [undefined, null, 'str', 5, ['a']]) {
      assert.deepEqual(summarizeArgs(v), { argKeys: [], argPreview: null, argBytes: null });
    }
  });

  it('redacts secrets inside preview values', () => {
    const s = summarizeArgs({ query: 'find ghp_abcdefghijklmnop1234 in repo' });
    assert.equal(s.argPreview!.query, 'find ghp_[REDACTED] in repo');
  });
});

describe('redactSecrets', () => {
  const cases: Array<[string, string]> = [
    ['Bearer abcdefghijklmnop', 'Bearer [REDACTED]'],
    ['eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', '[REDACTED_JWT]'],
    ['github_pat_11ABCDEFG0123456789', 'github_pat_[REDACTED]'],
    ['ghp_abcdefghijklmnop1234', 'ghp_[REDACTED]'],
    ['gho_abcdefghijklmnop1234', 'gho_[REDACTED]'],
    ['xoxb-1234-5678-abcdefgh', 'xoxb-[REDACTED]'],
    ['xoxp-1234-5678-abcdefgh', 'xoxp-[REDACTED]'],
    ['sbp_0123456789abcdef', 'sbp_[REDACTED]'],
    ['pcsk_0123456789abcdef', 'pcsk_[REDACTED]'],
    ['sk-0123456789abcdefghij', 'sk-[REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    it(`redacts ${expected}`, () => {
      assert.equal(redactSecrets(`token ${input} end`), `token ${expected} end`);
    });
  }

  it('leaves ordinary text alone', () => {
    const text = 'search for sk and ghp issues in the backlog';
    assert.equal(redactSecrets(text), text);
  });
});

describe('summarizeError', () => {
  it('uses the error name as the kind and caps + redacts the message', () => {
    const err = new Error('x'.repeat(ERROR_MESSAGE_MAX_CHARS + 50));
    const s = summarizeError(err);
    assert.equal(s.kind, 'Error');
    assert.equal(s.message.length, ERROR_MESSAGE_MAX_CHARS);

    const named = Object.assign(new Error('token xoxb-1234-5678-abcdefgh rejected'), { name: 'UserError' });
    assert.deepEqual(summarizeError(named), { kind: 'UserError', message: 'token xoxb-[REDACTED] rejected' });
  });

  it('handles non-Error throws', () => {
    assert.deepEqual(summarizeError('boom'), { kind: 'Error', message: 'boom' });
  });
});

describe('redactAndTruncate', () => {
  // Any run of token characters after a secret prefix, other than a placeholder.
  const LEAK = /\b(ghp_|sbp_|xoxb-)[A-Za-z0-9]/;

  it('redacts a token that straddles the cut instead of storing its prefix', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    // `at` is where the token starts; it follows a space, as in real text,
    // because the patterns only match a token that starts at a word boundary.
    for (let at = PREVIEW_MAX_CHARS - 13; at <= PREVIEW_MAX_CHARS; at++) {
      const out = redactAndTruncate('x'.repeat(at - 1) + ' ' + token, PREVIEW_MAX_CHARS);
      assert.ok(out.length <= PREVIEW_MAX_CHARS);
      assert.doesNotMatch(out, LEAK, `token starting at ${at} leaked: …${out.slice(-20)}`);
    }
  });

  it('masks a fragment cut off at the redaction window, not just at the final cut', () => {
    // Long JWTs shrink to a short placeholder, pulling text from near the end
    // of the 4x window into the final 200 characters — including a token the
    // window itself cut short.
    const jwt = 'eyJ' + 'a'.repeat(80) + '.' + 'b'.repeat(80) + '.' + 'c'.repeat(80);
    const head = Array(3).fill(jwt).join(' ') + ' ';
    const window = PREVIEW_MAX_CHARS * 4;
    const pad = 'p'.repeat(window - head.length - ' sbp_'.length - 6);
    const input = head + pad + ' sbp_' + 'S'.repeat(40);
    assert.equal(input.slice(window - 10, window), 'sbp_SSSSSS');
    const out = redactAndTruncate(input, PREVIEW_MAX_CHARS);
    assert.doesNotMatch(out, LEAK);
  });

  it('leaves untruncated text alone, including short look-alikes', () => {
    assert.equal(redactAndTruncate('ask sk-abc about it', 200), 'ask sk-abc about it');
  });

  it('applies to error messages at their own cap', () => {
    const err = new Error('x'.repeat(ERROR_MESSAGE_MAX_CHARS - 7) + ' xoxb-1234-5678-abcdefgh');
    assert.doesNotMatch(summarizeError(err).message, LEAK);
  });
});
