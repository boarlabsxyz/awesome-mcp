import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { required, optionalNumber } from '../../../env.ts';

// Everything here needs a document big enough that truncation actually happens.
// On the fixture account -- a few short paragraphs -- all three of these pass
// vacuously, which is the whole argument for a second, data-heavy account.

const DOC_ID = required('E2E_RICH_DOC_ID');
const MIN_CHARS = optionalNumber('E2E_RICH_DOC_MIN_CHARS', 20_000);

test('readGoogleDoc returns the whole document when maxLength is omitted', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'readGoogleDoc',
    service: 'google-docs',
    account: 'rich',
    shape: 'volume',
    args: { documentId: DOC_ID, format: 'text' },
    invariants: {
      minLength: MIN_CHARS,
      transportSafe: true,
      // Positively the whole-document form, not merely long: a truncated reply
      // on a large enough document would also clear minLength.
      matches: [/^Content \(\d+ characters\):/],
    },
  });
});

test('readGoogleDoc truncates text without splitting a character', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'readGoogleDoc',
    service: 'google-docs',
    account: 'rich',
    shape: 'volume',
    // An odd boundary on purpose: an even cut can land between code units by
    // luck, and a passing check would then prove nothing.
    args: { documentId: DOC_ID, format: 'text', maxLength: 4097 },
    invariants: {
      transportSafe: true,
      // Read the tool's own header rather than measuring the response. The reply
      // wraps the content in "Content (truncated to N chars of M total):" plus a
      // trailing note, so the response length is not the content length and a
      // length comparison answers the wrong question.
      predicate: (body) => {
        const header = body.match(/^Content \(truncated to (\d+) chars of (\d+) total\)/);
        if (!header) {
          // Either the document is shorter than maxLength, in which case nothing
          // was truncated and this check proves nothing, or the response shape
          // changed. Both need a human.
          return 'the response is not the truncated form. Point E2E_RICH_DOC_ID at a ' +
            `document longer than 4097 characters. Got: ${JSON.stringify(body.slice(0, 80))}`;
        }
        const [, shown, total] = header;
        if (Number(shown) !== 4097) return `asked for 4097 chars, header says ${shown}`;
        if (Number(total) <= Number(shown)) {
          return `header reports ${total} total, which is not more than the ${shown} shown`;
        }
        return undefined;
      },
    },
  });
});

// A regression lock on src/google-docs/textSafety.ts. The old json branch did
//
//   jsonContent.substring(0, maxLength) + '\n... [JSON truncated: N total chars]'
//
// which handed back a fragment of serialised JSON, so a caller that parsed it got
// "EOF while parsing a string" and read it as a transport failure. The fix moves
// the partial into a string field inside a valid envelope. Verified live against
// dev: a 1,838,547-char document truncated at 4097 comes back as
// { truncated, originalLength, note, truncatedJson } and parses.
//
// The envelope assertions are what stop this passing vacuously -- parsesAsJson
// alone is satisfied by any document small enough that truncation never ran.
test('readGoogleDoc format:json stays parseable when truncated', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'readGoogleDoc',
    service: 'google-docs',
    account: 'rich',
    shape: 'volume',
    args: { documentId: DOC_ID, format: 'json', maxLength: 4097 },
    invariants: {
      parsesAsJson: true,
      noLoneSurrogates: true,
      predicate: (body) => {
        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(body);
        } catch {
          return undefined; // parsesAsJson already reported it
        }
        if (envelope.truncated !== true) {
          return 'the response was not truncated -- point E2E_RICH_DOC_ID at a document ' +
            'whose JSON exceeds maxLength, or this check proves nothing';
        }
        if (typeof envelope.truncatedJson !== 'string') {
          return 'the partial is not a string field: the fragment is back on the wire as ' +
            'raw JSON, which is the bug this locks';
        }
        if (typeof envelope.originalLength !== 'number' || envelope.originalLength <= 4097) {
          return `originalLength ${String(envelope.originalLength)} does not report a document ` +
            'larger than the limit';
        }
        return undefined;
      },
    },
  });
});
