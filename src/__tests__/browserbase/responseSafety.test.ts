// src/__tests__/browserbase/responseSafety.test.ts
// These assertions are written against the three things a live run actually
// produced, not against imagined payloads — see responseSafety.ts's header.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ERROR_CHARS,
  MAX_PAYLOAD_CHARS,
  collapseRuns,
  extractNavigationFacts,
  redactSecrets,
  renderPayload,
  safeErrorText,
  sanitize,
  sanitizeNote,
  unwrapEnvelope,
} from '../../browserbase/responseSafety.js';

// A JWE-shaped signing key of the kind seen in the connect URL.
const KEY = `eyJ${'A1b2C3d4E5f6G7h8'.repeat(4)}.${'Zz9Yy8Xx7'.repeat(3)}.${'Qq1Ww2Ee3'.repeat(3)}`;
const CONNECT_URL = `ws://go-connect.connect.svc.cluster.local:8080/?signingKey=${KEY}`;

describe('redactSecrets', () => {
  it('removes the internal connect websocket URL whole', () => {
    const { text, redacted } = redactSecrets(`connectUrl: "${CONNECT_URL}"`);
    assert.ok(!text.includes('signingKey='), 'the key parameter survived');
    assert.ok(!text.includes(KEY), 'the key value survived');
    assert.ok(!text.includes('svc.cluster.local'), 'the internal host survived');
    assert.match(text, /\[redacted websocket URL\]/);
    assert.ok(redacted.includes('websocket URL'));
  });

  it('removes a standalone signing key, however many times it appears', () => {
    // The live payload repeated it about four times, outside the URL too.
    const { text } = redactSecrets([KEY, KEY, `key=${KEY}`, KEY].join(' | '));
    assert.ok(!text.includes(KEY));
    assert.ok(!/eyJ/.test(text), 'no token prefix should remain');
  });

  it('removes an internal cluster hostname on its own', () => {
    const { text, redacted } = redactSecrets('host: go-connect.connect.svc.cluster.local:8080');
    assert.match(text, /\[internal host\]/);
    assert.ok(!text.includes('cluster.local'));
    assert.ok(redacted.includes('internal host'));
  });

  it('redacts secret-shaped query parameters whatever the value format', () => {
    const { text } = redactSecrets('https://x.test/a?apiKey=plain-not-a-jwt&keep=yes');
    assert.match(text, /apiKey=\[redacted\]/);
    // Non-secret parameters are left alone — this is not a blanket scrub.
    assert.match(text, /keep=yes/);
  });

  it('leaves ordinary content untouched and reports nothing', () => {
    const input = 'Plan: Pro — $20/month. Contact sales@example.com.';
    const { text, redacted } = redactSecrets(input);
    assert.equal(text, input);
    assert.deepEqual(redacted, []);
  });

  it('is reusable — the module-level /g patterns do not carry lastIndex', () => {
    // A stale lastIndex on a shared regex makes every second call miss, which
    // would be a silent leak on alternating requests.
    for (let i = 0; i < 4; i += 1) {
      const { text } = redactSecrets(`attempt ${i}: ${CONNECT_URL}`);
      assert.ok(!text.includes(KEY), `call ${i} leaked the key`);
    }
  });
});

describe('collapseRuns', () => {
  it('collapses the degenerate newline run a stuck extraction model emits', () => {
    const { text, collapsed } = collapseRuns(`start${'\n'.repeat(5000)}end`);
    assert.equal(collapsed, true);
    assert.match(text, /5000 repeated newline characters removed/);
    // Collapsing rather than only truncating is what keeps the real content
    // that followed the run.
    assert.match(text, /start/);
    assert.match(text, /end/);
    assert.ok(text.length < 200);
  });

  it('leaves normal prose and short runs alone', () => {
    const input = 'A paragraph.\n\nAnother one, with    spacing.';
    const { text, collapsed } = collapseRuns(input);
    assert.equal(text, input);
    assert.equal(collapsed, false);
  });
});

describe('sanitize', () => {
  it('collapses a run and redacts a key in the same payload', () => {
    const input = `${'\n'.repeat(3000)}${CONNECT_URL} ${'z'.repeat(9000)}`;
    const result = sanitize(input);
    assert.ok(!result.text.includes(KEY));
    assert.equal(result.collapsed, true);
    // Nothing is truncated here, and that is the ordering working: collapsing
    // the two runs first leaves a payload small enough that the cap never
    // applies. Truncating first would have thrown the real content away.
    assert.equal(result.truncated, false);
    assert.ok(result.text.length < 300, `was ${result.text.length} chars`);
  });

  it('caps genuinely long content that has no collapsible run', () => {
    const result = sanitize('abcd'.repeat(5_000));
    assert.equal(result.collapsed, false);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= MAX_PAYLOAD_CHARS + 80, `was ${result.text.length} chars`);
    assert.match(result.text, /truncated, 20000 characters total/);
  });

  it('reports a clean payload as untouched', () => {
    const result = sanitize('Example Domain');
    assert.equal(result.text, 'Example Domain');
    assert.deepEqual(result.redacted, []);
    assert.equal(result.collapsed, false);
    assert.equal(result.truncated, false);
    assert.equal(sanitizeNote(result), '');
  });

  it('says what it did when it did something', () => {
    const note = sanitizeNote(sanitize(`${CONNECT_URL}${'\n'.repeat(500)}`));
    assert.match(note, /credentials and internal addresses were removed/);
    assert.match(note, /repeated characters was collapsed/);
  });

  it('tolerates empty and nullish input', () => {
    assert.equal(sanitize('').text, '');
    assert.equal(sanitize(undefined as any).text, '');
  });
});

describe('sanitize ordering', () => {
  it('redacts a secret that a collapse would otherwise split below the pattern', () => {
    // The near-miss: collapsing first turns `eyJ` + 81 identical base64url
    // characters into `eyJAAA…[81 repeated …]`, whose remaining fragment is
    // under the token pattern's 20-character minimum — so the redactor stops
    // matching and part of the key survives. Redacting first removes the class.
    const degenerate = `eyJ${'A'.repeat(81)}`;
    const result = sanitize(`connectUrl token: ${degenerate}`);
    assert.ok(!result.text.includes('eyJ'), `token prefix survived: ${result.text}`);
    assert.ok(result.redacted.includes('token'));
  });

  it('still collapses before capping, so the cap keeps real content', () => {
    // The other direction: if the cap ran before the collapse it would spend
    // its whole budget on newlines and discard what followed.
    const result = sanitize(`${'\n'.repeat(200_000)}the real content`);
    assert.match(result.text, /the real content/);
    assert.equal(result.collapsed, true);
    assert.equal(result.truncated, false);
  });
});

describe('safeErrorText', () => {
  it('caps the 214 KB upstream error that overflowed a client', () => {
    // AI_NoObjectGeneratedError echoed the model's whole degenerate output.
    const raw = `AI_NoObjectGeneratedError: ${'\n'.repeat(214_000)}`;
    const text = safeErrorText(raw);
    assert.ok(text.length <= MAX_ERROR_CHARS + 80, `was ${text.length} chars`);
    // The useful part — which error it was — has to survive the cap.
    assert.match(text, /AI_NoObjectGeneratedError/);
  });

  it('redacts credentials on the error path too', () => {
    // Redaction has to cover every exit, not just the happy one.
    assert.ok(!safeErrorText(`failed talking to ${CONNECT_URL}`).includes(KEY));
  });
});

describe('unwrapEnvelope', () => {
  it('unwraps the hosted {success,data} envelope', () => {
    assert.deepEqual(unwrapEnvelope('{"success":true,"data":{"title":"Example"}}'), { title: 'Example' });
  });

  it('returns a plain JSON object unchanged when it is not that envelope', () => {
    assert.deepEqual(unwrapEnvelope('{"title":"Example"}'), { title: 'Example' });
  });

  it('passes prose and malformed JSON through untouched', () => {
    assert.equal(unwrapEnvelope('Navigated successfully.'), 'Navigated successfully.');
    assert.equal(unwrapEnvelope('{not json'), '{not json');
    assert.equal(unwrapEnvelope(''), '');
  });
});

describe('renderPayload', () => {
  it('renders a string as itself and an object as indented JSON', () => {
    assert.equal(renderPayload('plain'), 'plain');
    assert.equal(renderPayload({ a: 1 }), '{\n  "a": 1\n}');
    assert.equal(renderPayload(42), '42');
    assert.equal(renderPayload(null), '');
    assert.equal(renderPayload(undefined), '');
  });

  it('does not throw on a circular payload', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => renderPayload(circular));
  });
});

describe('extractNavigationFacts', () => {
  it('pulls status and title out of a nested CDP-ish payload', () => {
    const facts = extractNavigationFacts({
      page: { title: 'Example Domain', response: { status: 200 } },
      connectUrl: CONNECT_URL,
    });
    assert.equal(facts.status, 200);
    assert.equal(facts.title, 'Example Domain');
  });

  it('ignores a non-HTTP "status" like RUNNING', () => {
    // Session status and HTTP status share a key name upstream.
    assert.equal(extractNavigationFacts({ status: 'RUNNING' }).status, undefined);
    assert.equal(extractNavigationFacts({ status: 42 }).status, undefined);
  });

  it('returns nothing rather than guessing when the payload has neither', () => {
    assert.deepEqual(extractNavigationFacts({ connectUrl: CONNECT_URL, sessionId: 'x' }), {});
    assert.deepEqual(extractNavigationFacts('prose'), {});
    assert.deepEqual(extractNavigationFacts(null), {});
  });

  it('caps a very long title', () => {
    const facts = extractNavigationFacts({ title: 'x'.repeat(5000) });
    assert.ok((facts.title ?? '').length <= 300);
  });

  it('terminates on a deeply nested payload', () => {
    let deep: any = { title: 'too deep to matter' };
    for (let i = 0; i < 500; i += 1) deep = { nested: deep };
    assert.doesNotThrow(() => extractNavigationFacts(deep));
  });

  it('redacts a secret carried INSIDE the allowed title field', () => {
    // The allowlist stops an unknown FIELD; it says nothing about what an
    // allowed field contains. A page whose <title> holds a token, or an
    // upstream that puts one there, would otherwise pass straight through.
    const facts = extractNavigationFacts({ status: 200, title: `Login — ${KEY}` });
    assert.equal(facts.status, 200);
    assert.ok(!(facts.title ?? '').includes(KEY), `title leaked: ${facts.title}`);
    assert.ok(!(facts.title ?? '').includes('eyJ'));
    assert.match(facts.title ?? '', /Login/);
  });

  it('never surfaces a secret, whatever the key is called', () => {
    // The whole point of the allowlist: a field this function does not name
    // cannot reach the caller, even one added upstream tomorrow.
    const facts = extractNavigationFacts({
      status: 200, title: 'OK',
      signingKey: KEY, connectUrl: CONNECT_URL, somethingNew: KEY,
    });
    assert.deepEqual(facts, { status: 200, title: 'OK' });
    assert.ok(!JSON.stringify(facts).includes('eyJ'));
  });
});
