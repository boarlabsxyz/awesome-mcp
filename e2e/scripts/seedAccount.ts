// Creates the content the checks assert against, and prints the env vars that
// point at it.
//
// Two of the variables in accounts.md cannot sensibly be produced by hand: the
// rich account needs enough documents for a paging cap to be observable, and one
// document long enough for truncation to happen. Hand-making 60 docs is absurd,
// so this does it and prints the result in copy-paste form.
//
//   E2E_SEED_CONFIRM=1 npm run seed:account -- fixture
//   E2E_SEED_CONFIRM=1 npm run seed:account -- rich
//   E2E_SEED_CONFIRM=1 npm run seed:account -- sandbox
//
// The confirm flag is not ceremony. This is the one part of the harness that
// writes to the fixture and rich accounts -- the two that every other check
// treats as immutable -- so running it against the wrong one silently
// invalidates assertions elsewhere. It prints the target and refuses without it.

import { endpointFor, type AccountName } from '../accounts.ts';
import { connectMcp, type McpClient } from '../transports/mcpHttp.ts';
import { bulkText } from '../setup/docsScratch.ts';

const FIXTURE_TITLE = process.env.E2E_SEED_FIXTURE_TITLE ?? 'E2E Smoke Fixture Doc';
const FIXTURE_NEEDLE = process.env.E2E_SEED_NEEDLE ?? 'BANANA-PHONE-7714';
const RICH_DOC_COUNT = Number(process.env.E2E_SEED_RICH_DOCS ?? 60);
const RICH_DOC_TITLE = 'E2E Volume Fixture Doc';
const RICH_DOC_PARAGRAPHS = Number(process.env.E2E_SEED_RICH_PARAGRAPHS ?? 400);
const SANDBOX_FOLDER_NAME = 'E2E Sandbox Scratch';

const account = process.argv[2] as AccountName | undefined;

if (!account || !['fixture', 'rich', 'sandbox'].includes(account)) {
  fail('Usage: npm run seed:account -- <fixture|rich|sandbox>');
}

const endpoint = await endpointFor(account!, 'google-drive');
console.log(`About to WRITE to the '${account}' account at ${endpoint.url}`);
if (process.env.E2E_SEED_CONFIRM !== '1') {
  fail('Refusing to write without E2E_SEED_CONFIRM=1. Check the account above first.');
}

// Two services, deliberately: createDocument / createFolder are registered on
// the drive server, listGoogleDocs on the docs one, and each deployment runs
// them as separate hosts. One client cannot do both.
const drive = await connectMcp(endpoint);
const docs = await connectMcp(await endpointFor(account!, 'google-docs'));
try {
  if (account === 'fixture') await seedFixture(drive, docs);
  else if (account === 'rich') await seedRich(drive, docs);
  else await seedSandbox(drive);
} finally {
  await Promise.all([drive.close(), docs.close()]);
}

/**
 * One frozen doc carrying the needle.
 *
 * Idempotent by title: a second run must not leave two docs with the same name,
 * because the needle check asserts a specific ID and would then be asserting
 * against whichever copy Drive happened to list first.
 */
async function seedFixture(drive: McpClient, docs: McpClient): Promise<void> {
  const existing = await findByTitle(docs, FIXTURE_TITLE);
  const id = existing ?? (await createDoc(drive, docs, FIXTURE_TITLE, `${FIXTURE_NEEDLE}\n`));
  console.log(existing ? '\nFixture doc already existed, reusing it.' : '\nCreated the fixture doc.');
  print({
    E2E_FIXTURE_DOC_ID: id,
    E2E_FIXTURE_DOC_TITLE: FIXTURE_TITLE,
    E2E_FIXTURE_DOC_NEEDLE: FIXTURE_NEEDLE,
  });
  console.log(
    '\nDo not edit this document afterwards -- the needle check asserts its bytes.\n' +
      'The same three values belong in the repo Actions variables, which is where\n' +
      'e2e-smoke.yml reads them from (they are not set today).',
  );
}

/** Enough documents that a page cap is visible, plus one long enough to truncate. */
async function seedRich(drive: McpClient, docs: McpClient): Promise<void> {
  const existingLong = await findByTitle(docs, RICH_DOC_TITLE);
  const longId =
    existingLong ??
    (await createDoc(drive, docs, RICH_DOC_TITLE, bulkText(RICH_DOC_PARAGRAPHS, 'VOLUME')));

  const have = await countDocs(docs);
  console.log(`\nAccount currently lists ${have} document(s).`);

  for (let i = have; i < RICH_DOC_COUNT; i++) {
    await createDoc(drive, docs, `E2E Volume Filler ${String(i + 1).padStart(3, '0')}`, `filler ${i + 1}`);
    if ((i + 1) % 10 === 0) console.log(`  created ${i + 1}/${RICH_DOC_COUNT}`);
  }

  print({
    E2E_RICH_DOC_ID: longId,
    E2E_RICH_MIN_DOCS: String(Math.min(RICH_DOC_COUNT, 50)),
  });
  console.log(
    `\nThe long doc is ~${RICH_DOC_PARAGRAPHS} paragraphs. If E2E_RICH_DOC_MIN_CHARS (default\n` +
      '20000) is above what that produces, the full-read check fails on the fixture,\n' +
      'not on the tool -- raise E2E_SEED_RICH_PARAGRAPHS and re-run.',
  );
}

/** A folder to keep scratch docs out of the account root. */
async function seedSandbox(drive: McpClient): Promise<void> {
  const { text, isError } = await drive.callTool('createFolder', { name: SANDBOX_FOLDER_NAME });
  if (isError) fail(`createFolder failed: ${text}`);
  const id = parseId(text);
  print({ E2E_SANDBOX_FOLDER_ID: id });
  console.log(
    '\nOptional -- without it scratch docs are created in the account root and still\n' +
      'get trashed by teardown and by `npm run sweep:sandbox`.',
  );
}

/**
 * Create on drive, fill on docs.
 *
 * createDocument takes an `initialContent` argument, and on this deployment it
 * does not work: the file is created and the content insert fails, reported only
 * in the prose of an otherwise-successful reply. Writing the content through the
 * docs server's appendToGoogleDoc is both reliable and verifiable.
 */
async function createDoc(
  drive: McpClient,
  docs: McpClient,
  title: string,
  initialContent: string,
): Promise<string> {
  const created = await drive.callTool('createDocument', { title });
  if (created.isError) fail(`createDocument failed: ${created.text}`);
  const id = parseId(created.text);

  const filled = await docs.callTool('appendToGoogleDoc', { documentId: id, textToAppend: initialContent });
  if (filled.isError) fail(`created "${title}" but could not fill it: ${filled.text}`);

  const back = await docs.callTool('readGoogleDoc', { documentId: id, format: 'text' });
  if (back.text.length < initialContent.length / 2) {
    fail(`"${title}" reads back as ${back.text.length} chars after seeding ${initialContent.length}.`);
  }
  console.log(`   ${title}: ${back.text.length} chars`);
  return id;
}

/** Exact-title match on the DOCS server; listGoogleDocs' query is a substring search. */
async function findByTitle(docs: McpClient, title: string): Promise<string | null> {
  const { text } = await docs.callTool('listGoogleDocs', { query: title, maxResults: 100 });
  for (const [, name, id] of text.matchAll(/^\d+\. \*\*(.+?)\*\*.*\n\s+ID: (\S+)/gm)) {
    if (name === title) return id;
  }
  return null;
}

async function countDocs(docs: McpClient): Promise<number> {
  const { text } = await docs.callTool('listGoogleDocs', { maxResults: 100 });
  return Number(text.match(/Found (\d+) Google Document\(s\)/)?.[1] ?? 0);
}

function parseId(text: string): string {
  const id = text.match(/\(ID: ([^)]+)\)/)?.[1];
  if (!id) fail(`Could not parse an ID out of: ${text}`);
  return id!;
}

function print(vars: Record<string, string>): void {
  console.log('\nAdd to your environment:\n');
  for (const [k, v] of Object.entries(vars)) console.log(`export ${k}="${v}"`);
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}
