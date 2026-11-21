import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInvariants,
  findLoneSurrogate,
  findReportedFailure,
  findUnsafeChar,
} from '../../assertions.ts';
import { scratchTitle, sweepCutoff, sweepScratch } from '../../setup/docsScratch.ts';
import { createdEventId, sweepScratchEvents } from '../../setup/calendarScratch.ts';
import { checkFixtureTaskRow } from '../tools/clickupTaskRow.ts';
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

// Each fake answers ONLY the tools its real server registers and throws the
// same "Unknown tool" a FastMCP server throws otherwise. An earlier sweeper
// called a docs-server tool and a drive-server tool on one client, which a
// permissive fake happily answered and a live run did not.
function fake(name: string, tools: Record<string, (args: any) => string>): McpClient {
  return {
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
  };
}

/** A searchDriveFiles entry (fileLine in src/google-drive/server.ts). */
const driveEntry = (n: number, name: string, mimeType: string, id: string) =>
  `${n}. **${name}** (${mimeType})\n   ID: ${id} · modified 2026-01-01 00:00\n   https://example.test/${id}`;
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';

test('sweepScratch trashes stale scratch docs, sheets and folders, and nothing else', async () => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const deleted: string[] = [];
  const listing = [
    '5 file(s), sorted by modifiedTime desc:',
    '',
    // A folder listed FIRST is still trashed LAST, after the files it may hold.
    driveEntry(1, scratchTitle('folderTool', hourAgo), FOLDER, 'folder-old'),
    driveEntry(2, scratchTitle('docTool', hourAgo), DOC, 'doc-old'),
    driveEntry(3, scratchTitle('sheetTool', hourAgo), SHEET, 'sheet-old'),
    driveEntry(4, scratchTitle('freshTool'), DOC, 'doc-fresh'),
    // A human-named file that merely contains the query -- must survive, since
    // the sweeper dates a file from its title and this one carries no stamp.
    driveEntry(5, 'e2e-notes-do-not-delete', DOC, 'doc-human'),
  ].join('\n\n');

  const drive = fake('fake-drive', {
    searchDriveFiles: (args) => {
      assert.equal(args.searchIn, 'name');
      return listing;
    },
    deleteFile: (args) => {
      deleted.push(String(args.fileId));
      return 'Moved file to trash.';
    },
  });

  const result = await sweepScratch(drive, { maxAgeHours: 0.5 });
  assert.deepEqual(deleted, ['doc-old', 'sheet-old', 'folder-old']);
  assert.equal(result.trashed.length, 3);
  assert.equal(result.kept, 2);
  assert.equal(result.capped, false);
});

test('sweepScratch follows the page token and says when it stopped early', async () => {
  const stale = (id: string) => driveEntry(1, scratchTitle(id, Date.now() - 60 * 60 * 1000), DOC, id);
  const pages: string[] = [];
  const drive = fake('fake-drive', {
    searchDriveFiles: (args) => {
      pages.push(String(args.pageToken ?? 'first'));
      // Every page points at another, so only the page cap ends the loop.
      return `1 file(s), sorted by modifiedTime desc:\n\n${stale(`doc-${pages.length}`)}\nMORE results: call again with pageToken "p${pages.length + 1}".`;
    },
    deleteFile: () => 'Moved file to trash.',
  });

  const result = await sweepScratch(drive, { maxAgeHours: 0.5, dryRun: true });
  assert.equal(pages[0], 'first');
  assert.equal(pages[1], 'p2');
  assert.equal(result.trashed.length, pages.length);
  assert.equal(result.capped, true);
});

test('sweepScratchEvents deletes stale scratch events only', async () => {
  const deleted: string[] = [];
  const stale = scratchTitle('createEvent-zero', Date.now() - 60 * 60 * 1000);
  const calendar = fake('fake-calendar', {
    listEvents: () =>
      `Found 3 event(s):\n\n1. **${stale}**\n   ID: ev-old\n\n` +
      `2. **${scratchTitle('createEvent-zero')}**\n   ID: ev-fresh\n\n3. **Team sync**\n   ID: ev-human\n`,
    deleteEvent: (args) => {
      assert.equal(args.sendUpdates, 'none');
      deleted.push(String(args.eventId));
      return 'Event deleted.';
    },
  });

  const result = await sweepScratchEvents(calendar, { calendarId: 'primary', maxAgeHours: 0.5 });
  assert.deepEqual(deleted, ['ev-old']);
  assert.equal(result.kept, 2);
  assert.equal(result.capped, false);
});

test('a negative or NaN sweep age is refused, not turned into a future cutoff', () => {
  assert.throws(() => sweepCutoff(-1), /non-negative/);
  assert.throws(() => sweepCutoff(Number.NaN), /non-negative/);
});

test('createdEventId reads the ID line of createEvent\'s reply', () => {
  assert.equal(createdEventId('Event created successfully!\n**Title:** x\n**ID:** abc123\n**Status:** confirmed'), 'abc123');
  assert.equal(createdEventId(undefined), undefined);
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

test('checkFixtureTaskRow ties the needle and home list to the fixture task row', () => {
  const row = (id: string, name: string, list: string) => `Task: ${name}\n  ID: ${id}\n  Status: open\n  List: Home (${list})`;
  const opts = { taskId: 't1', listId: 'L1', needle: 'NEEDLE-7' };
  assert.equal(checkFixtureTaskRow([row('t0', 'other', 'L1'), row('t1', 'NEEDLE-7 fixture', 'L1')].join('\n\n'), opts), undefined);
  // The needle on ANOTHER task no longer satisfies the check.
  assert.match(checkFixtureTaskRow([row('t0', 'NEEDLE-7 copy', 'L1'), row('t1', 'renamed', 'L1')].join('\n\n'), opts) ?? '', /named "Task: renamed"/);
  assert.match(checkFixtureTaskRow(row('t2', 'NEEDLE-7', 'L1'), opts) ?? '', /no task row has ID t1/);
  assert.match(checkFixtureTaskRow(row('t1', 'NEEDLE-7', 'L9'), opts) ?? '', /home list L1/);
});
