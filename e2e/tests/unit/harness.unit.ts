import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInvariants, findLoneSurrogate, findUnsafeChar } from '../../assertions.ts';
import { scratchTitle, sweepScratch } from '../../setup/docsScratch.ts';
import type { McpClient, ToolResult } from '../../transports/mcpHttp.ts';

// The invariant engine and the sweeper are the two pieces every future check
// depends on, and both are testable with no accounts and no network. Worth
// running in ordinary CI: a broken invariant does not fail, it passes silently,
// and a broken sweeper deletes the wrong thing.

const VERTICAL_TAB = String.fromCharCode(0x0b);
const PRIVATE_USE = String.fromCharCode(0xe907);

test('findLoneSurrogate catches a cut surrogate pair and accepts a whole one', () => {
  const emoji = String.fromCodePoint(0x1f34c); // a two-code-unit character
  assert.equal(findLoneSurrogate(`ok ${emoji} ok`), -1);
  // What substring(0, n) does when n lands inside the pair:
  const cut = `ok ${emoji}`.substring(0, 4);
  assert.equal(findLoneSurrogate(cut), 3);
});

test('findUnsafeChar catches the characters Docs emits internally', () => {
  assert.equal(findUnsafeChar('plain text'), null);
  assert.deepEqual(findUnsafeChar(`a${VERTICAL_TAB}b`), { offset: 1, code: 0x0b });
  assert.deepEqual(findUnsafeChar(`a${PRIVATE_USE}b`), { offset: 1, code: 0xe907 });
});

test('parsesAsJson catches the sliced-JSON truncation bug', () => {
  const whole = JSON.stringify({ body: { content: ['lorem ipsum dolor sit amet'] } }, null, 2);
  // Exactly what readGoogleDoc's json branch does today.
  const sliced = `${whole.substring(0, 40)}\n... [JSON truncated: ${whole.length} total chars]`;

  checkInvariants(whole, { parsesAsJson: true });
  assert.throws(() => checkInvariants(sliced, { parsesAsJson: true }), /not valid JSON/);
});

test('checkInvariants reports every failure at once, not just the first', () => {
  assert.throws(
    () => checkInvariants('short', { includes: ['missing'], minLength: 100, minLines: 4 }),
    (err: Error) => /3 invariant\(s\) failed/.test(err.message),
  );
});

test('between narrows the body before asserting', () => {
  const body = 'noise BEGIN wanted END noise';
  checkInvariants(body, { between: ['BEGIN', 'END'], includes: ['wanted'], excludes: ['noise'] });
  assert.throws(() => checkInvariants('no markers', { between: ['BEGIN', 'END'] }), /missing delimiters/);
});

test('minLines counts non-empty lines', () => {
  checkInvariants('a\n\nb\n\nc', { minLines: 3 });
  assert.throws(() => checkInvariants('a\n\nb', { minLines: 3 }), /2 non-empty lines/);
});

test('sweepScratch trashes only titles older than the cutoff', async () => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const old = scratchTitle('oldTool', hourAgo);
  const fresh = scratchTitle('freshTool');
  const deleted: string[] = [];

  const listing =
    `Found 3 Google Document(s):\n\n` +
    `1. **${old}**\n   ID: doc-old\n   Modified: 1/1/2026\n   Owner: e2e\n\n` +
    `2. **${fresh}**\n   ID: doc-fresh\n   Modified: 1/1/2026\n   Owner: e2e\n\n` +
    // A human-named doc that merely starts with the query -- must survive, since
    // the sweeper dates a doc from its title and this one carries no stamp.
    `3. **e2e-notes-do-not-delete**\n   ID: doc-human\n   Modified: 1/1/2026\n   Owner: e2e\n\n`;

  const fake: McpClient = {
    async callTool(name, args): Promise<ToolResult> {
      if (name === 'listGoogleDocs') return { text: listing, isError: false, raw: null };
      if (name === 'deleteFile') {
        deleted.push(String((args as { fileId: string }).fileId));
        return { text: 'Moved file to trash.', isError: false, raw: null };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    async listTools() {
      return [];
    },
    async close() {},
    describe: () => 'fake',
  };

  const result = await sweepScratch(fake, { maxAgeHours: 0.5 });
  assert.deepEqual(deleted, ['doc-old']);
  assert.equal(result.trashed.length, 1);
  assert.equal(result.kept, 2);
});
