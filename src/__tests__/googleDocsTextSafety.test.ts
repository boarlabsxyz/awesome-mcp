import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import {
  sliceSafe,
  sanitizeDocText,
  findUnencodable,
  formatCodePoint,
  assertTransportSafe,
  stringifySafe,
} from '../google-docs/textSafety.js';

// Built with fromCharCode so this file contains no raw control characters.
const VT = String.fromCharCode(0x0b);        // Docs' shift-enter soft line break
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const PUA = String.fromCharCode(0xe907);     // Docs inline-object placeholder
const HI = String.fromCharCode(0xd83d);      // lone high surrogate
const LO = String.fromCharCode(0xde00);      // lone low surrogate
const EMOJI = HI + LO;                       // U+1F600, one code point, two units
const FFFD = String.fromCharCode(0xfffd);

describe('sliceSafe', () => {
  it('never leaves a lone surrogate when the cut lands inside a pair', () => {
    const text = 'ab' + EMOJI + 'cd';
    // max=3 would keep only the high half. Back off instead of emitting it.
    assert.equal(sliceSafe(text, 3), 'ab');
    assert.equal(findUnencodable(sliceSafe(text, 3)), null);
  });

  it('keeps a whole pair when there is room for it', () => {
    const text = 'ab' + EMOJI + 'cd';
    assert.equal(sliceSafe(text, 4), 'ab' + EMOJI);
  });

  it('is a no-op when the text already fits', () => {
    assert.equal(sliceSafe('hello', 10), 'hello');
    assert.equal(sliceSafe('hello', 5), 'hello');
  });

  it('handles degenerate limits', () => {
    assert.equal(sliceSafe('hello', 0), '');
    assert.equal(sliceSafe('hello', -1), '');
  });

  it('cuts plain text exactly where substring would', () => {
    assert.equal(sliceSafe('abcdef', 3), 'abc');
  });

  it('produces a clean result at every possible cut of a surrogate-heavy string', () => {
    // The regression guard: substring() fails this at odd offsets.
    const text = EMOJI + 'x' + EMOJI + 'y' + EMOJI;
    for (let n = 0; n <= text.length; n++) {
      assert.equal(findUnencodable(sliceSafe(text, n)), null, `cut at ${n} left a lone surrogate`);
    }
  });
});

describe('sanitizeDocText', () => {
  it('turns U+000B into a newline rather than dropping it', () => {
    // Docs emits it for shift-enter; deleting it would join two lines.
    assert.equal(sanitizeDocText('line one' + VT + 'line two'), 'line one\nline two');
  });

  it('strips other C0 controls and DEL', () => {
    assert.equal(sanitizeDocText('a' + NUL + 'b' + DEL + 'c'), 'abc');
  });

  it('keeps tab, newline and carriage return', () => {
    assert.equal(sanitizeDocText('a\tb\nc\rd'), 'a\tb\nc\rd');
  });

  it('strips private-use inline-object placeholders', () => {
    assert.equal(sanitizeDocText('before' + PUA + 'after'), 'beforeafter');
  });

  it('replaces unpaired surrogates with U+FFFD', () => {
    assert.equal(sanitizeDocText('a' + HI + 'b'), 'a' + FFFD + 'b');
    assert.equal(sanitizeDocText('a' + LO + 'b'), 'a' + FFFD + 'b');
  });

  it('leaves a valid surrogate pair intact', () => {
    assert.equal(sanitizeDocText('a' + EMOJI + 'b'), 'a' + EMOJI + 'b');
  });

  it('output always survives a JSON round trip', () => {
    const nasty = 'a' + NUL + VT + PUA + HI + 'b' + EMOJI + LO;
    const clean = sanitizeDocText(nasty);
    assert.equal(JSON.parse(JSON.stringify(clean)), clean);
    assert.equal(findUnencodable(clean), null);
  });
});

describe('findUnencodable', () => {
  it('returns null for clean text', () => {
    assert.equal(findUnencodable('hello ' + EMOJI + ' world\ttabbed'), null);
  });

  it('reports the offset and code point of a lone high surrogate', () => {
    assert.deepEqual(findUnencodable('ok' + HI + 'bad'), { offset: 2, codePoint: 0xd83d });
  });

  it('reports a control character', () => {
    assert.deepEqual(findUnencodable('ab' + NUL), { offset: 2, codePoint: 0x00 });
  });

  it('reports the earliest offending character when several kinds are present', () => {
    const hit = findUnencodable('a' + NUL + 'bb' + HI);
    assert.equal(hit?.offset, 1);
  });
});

describe('formatCodePoint', () => {
  it('renders the U+XXXX form the error message promises', () => {
    assert.equal(formatCodePoint(0x0b), 'U+000B');
    assert.equal(formatCodePoint(0xd83d), 'U+D83D');
  });
});

describe('assertTransportSafe', () => {
  it('returns clean text unchanged so it can wrap a return value', () => {
    const text = 'Content (5 characters):\n---\nhello';
    assert.equal(assertTransportSafe(text), text);
  });

  it('names the offset, the code point and the document instead of letting it reach the client', () => {
    // The whole point: a diagnosable server-side error rather than an
    // "EOF while parsing a string" inside the caller's JSON parser.
    assert.throws(
      () => assertTransportSafe('ok' + HI + 'bad', { documentId: 'DOC123', what: 'text' }),
      (err: Error) => {
        // UserError, so FastMCP surfaces the message rather than framing it as
        // an internal execution failure.
        assert.ok(err instanceof UserError);
        assert.match(err.message, /U\+D83D/);
        assert.match(err.message, /offset 2/);
        assert.match(err.message, /DOC123/);
        assert.match(err.message, /text content/);
        return true;
      },
    );
  });

  it('works without context', () => {
    assert.throws(() => assertTransportSafe('bad' + LO), /U\+DE00/);
  });
});

describe('readGoogleDoc json truncation contract', () => {
  // The handler builds this envelope; the property under test is that the
  // response is parseable even when the payload had to be cut. Slicing the
  // serialised JSON directly — the old behaviour — produced a dangling string
  // and made every consumer fail with "EOF while parsing a string".
  function truncateEnvelope(payload: unknown, maxLength: number): string {
    const jsonContent = JSON.stringify(payload, null, 2);
    if (jsonContent.length > maxLength) {
      return JSON.stringify({
        truncated: true,
        originalLength: jsonContent.length,
        note: 'fragment',
        truncatedJson: sliceSafe(jsonContent, maxLength),
      }, null, 2);
    }
    return jsonContent;
  }

  const doc = { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'hello ' + EMOJI } }] } }] } };

  it('stays parseable at every truncation length', () => {
    const full = JSON.stringify(doc, null, 2);
    for (let n = 1; n < full.length; n++) {
      const out = truncateEnvelope(doc, n);
      assert.doesNotThrow(() => JSON.parse(out), `length ${n} produced unparseable JSON`);
    }
  });

  it('reports the original length and marks the fragment as partial', () => {
    const parsed = JSON.parse(truncateEnvelope(doc, 20));
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.originalLength, JSON.stringify(doc, null, 2).length);
    assert.equal(typeof parsed.truncatedJson, 'string');
  });

  it('returns plain JSON when nothing needed cutting', () => {
    const out = truncateEnvelope(doc, 100_000);
    assert.deepEqual(JSON.parse(out), doc);
  });
});

describe('stringifySafe', () => {
  // The gap assertTransportSafe structurally cannot close: after JSON.stringify
  // a lone surrogate is the six-ASCII escape \udXXX, so scanning the serialised
  // text for stray code units finds nothing, yet strict parsers reject it.
  const withLoneSurrogate = {
    title: 'Doc' + HI,
    body: { content: [{ paragraph: { elements: [{ textRun: { content: 'ok' + HI + 'bad' } }] } }] },
  };

  it('plain JSON.stringify leaks an escaped lone surrogate past the backstop', () => {
    const raw = JSON.stringify(withLoneSurrogate);
    assert.ok(raw.toLowerCase().includes('ud83d'), 'expected an escaped surrogate');
    assert.equal(findUnencodable(raw), null, 'backstop cannot see it — this is why stringifySafe exists');
  });

  it('sanitizes every string in the tree, including titles', () => {
    const out = stringifySafe(withLoneSurrogate);
    assert.ok(!out.toLowerCase().includes('ud83d'));
    const parsed = JSON.parse(out);
    assert.equal(parsed.title, 'Doc' + FFFD);
    assert.equal(parsed.body.content[0].paragraph.elements[0].textRun.content, 'ok' + FFFD + 'bad');
  });

  it('reaches nested text runs, tab titles and arrays alike', () => {
    const out = stringifySafe({
      tabs: [{ tabProperties: { title: 'Tab' + LO } }],
      notes: ['a' + NUL + 'b', 'c' + VT + 'd'],
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.tabs[0].tabProperties.title, 'Tab' + FFFD);
    assert.deepEqual(parsed.notes, ['ab', 'c\nd']);
  });

  it('leaves non-string values and valid text alone', () => {
    const payload = { n: 42, b: true, nil: null, ok: 'plain ' + EMOJI };
    assert.deepEqual(JSON.parse(stringifySafe(payload)), payload);
  });

  it('honours the space argument', () => {
    assert.ok(stringifySafe({ a: 1 }, 2).includes('\n  '));
  });
});
