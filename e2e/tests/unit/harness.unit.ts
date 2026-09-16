import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInvariants,
  findLoneSurrogate,
  findReportedFailure,
  findUnsafeChar,
} from '../../assertions.ts';
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

  // Each fake answers ONLY the tools its real server registers and throws the
  // same "Unknown tool" a FastMCP server throws otherwise. That is the whole
  // point of these doubles: an earlier version of sweepScratch took one client
  // and called listGoogleDocs (docs server) and deleteFile (drive server) on it,
  // which a permissive fake happily answered and a live run did not.
  const fake = (name: string, tools: Record<string, (args: any) => string>): McpClient => ({
    async callTool(tool, args): Promise<ToolResult> {
      const handler = tools[tool];
      if (!handler) throw new Error(`MCP error -32601: Unknown tool: ${tool}`);
      return { text: handler(args), isError: false, raw: null };
    },
    async listTools() {
      return Object.keys(tools);
    },
    async close() {},
    describe: () => name,
  });

  const docs = fake('fake-docs', { listGoogleDocs: () => listing });
  const drive = fake('fake-drive', {
    deleteFile: (args) => {
      deleted.push(String(args.fileId));
      return 'Moved file to trash.';
    },
  });

  const result = await sweepScratch({ docs, drive }, { maxAgeHours: 0.5 });
  assert.deepEqual(deleted, ['doc-old']);
  assert.equal(result.trashed.length, 1);
  assert.equal(result.kept, 2);
});

test('sweepScratch reaches for each tool on the server that registers it', async () => {
  // Regression lock on the service split. A single-client sweeper passes the
  // unit test above only because the doubles are separate; this asserts the
  // routing directly, so collapsing them back fails here rather than in prod.
  const asked: Record<string, string[]> = { docs: [], drive: [] };
  const spy = (which: string, reply: string): McpClient => ({
    async callTool(tool): Promise<ToolResult> {
      asked[which].push(tool);
      return { text: reply, isError: false, raw: null };
    },
    async listTools() {
      return [];
    },
    async close() {},
    describe: () => which,
  });

  const stale = scratchTitle('x', Date.now() - 60 * 60 * 1000);
  await sweepScratch(
    {
      docs: spy('docs', `Found 1 Google Document(s):\n\n1. **${stale}**\n   ID: doc-1\n`),
      drive: spy('drive', 'Moved file to trash.'),
    },
    { maxAgeHours: 0.5 },
  );

  assert.deepEqual(asked.docs, ['listGoogleDocs']);
  assert.deepEqual(asked.drive, ['deleteFile']);
});

// The live-client tier's whole value rests on this detector, and a detector that
// silently matches nothing passes every test it guards. These are the replies a
// model actually produced against the broken listGoogleDocs.
test('findReportedFailure catches a model explaining a tool failure', () => {
  const refusals = [
    "I don't have permission to search your Google Drive.",
    'I was unable to access your documents.',
    'It looks like an error occurred while searching.',
    'Permission denied when listing your files.',
    'I do not have access to that folder.',
    'I failed to retrieve the document list.',
    "I couldn't access your Drive.",
  ];
  for (const reply of refusals) {
    assert.notEqual(findReportedFailure(reply), null, `should have flagged: ${reply}`);
  }
});

// The distinction the whole detector turns on. "Unable to FIND" is a correct
// answer to a search with no matches; "unable to ACCESS" is a tool failure. A
// bare /unable to/ cannot tell them apart, and would fail a passing task purely
// on the model's choice of wording.
test('findReportedFailure leaves a genuine no-match reply alone', () => {
  const noMatches = [
    "I couldn't find any document mentioning that.",
    'I was unable to find a matching document.',
    'I am unable to find anything with that name.',
    "I wasn't able to find a doc about Q3 planning.",
    'No documents matched your search.',
    'OUTPUT_BEGINNeedleOUTPUT_END',
  ];
  for (const reply of noMatches) {
    assert.equal(findReportedFailure(reply), null, `should NOT have flagged: ${reply}`);
  }
});

test('findReportedFailure is case-insensitive and takes extra phrases', () => {
  assert.notEqual(findReportedFailure('I DO NOT HAVE ACCESS'), null);
  assert.equal(findReportedFailure('the connector is not configured'), null);
  assert.notEqual(findReportedFailure('the connector is not configured', ['not configured']), null);
  assert.notEqual(findReportedFailure('no connector present', [/no connector/i]), null);
});
