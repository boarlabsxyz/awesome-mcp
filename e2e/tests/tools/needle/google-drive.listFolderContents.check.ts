import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// Lists the fixture folder and expects the fixture doc in it. Line formats are
// copied from handleListFolderContents in src/google-drive/toolHandlers.ts:
// files render as "📄 <name>\n   ID: <id>" under a "Contents of folder (N
// item(s))" header.
//
// maxResults is the schema maximum so the doc is not paged out by a busy folder:
// the tool passes maxResults to Drive's pageSize and ignores nextPageToken, so a
// folder past 100 items would hide it and this check would read as a regression.

const env = serviceEnv('google-drive', [
  'E2E_FIXTURE_DRIVE_FOLDER_ID',
  'E2E_FIXTURE_DOC_ID',
  'E2E_FIXTURE_DOC_TITLE',
]);

test('listFolderContents lists the fixture doc in the fixture folder', { timeout: 30_000, skip: env.skip }, async () => {
  const FOLDER_ID = env.get('E2E_FIXTURE_DRIVE_FOLDER_ID');
  const DOC_ID = env.get('E2E_FIXTURE_DOC_ID');
  const DOC_TITLE = env.get('E2E_FIXTURE_DOC_TITLE');
  await runToolCheck({
    tool: 'listFolderContents',
    service: 'google-drive',
    account: 'fixture',
    shape: 'needle',
    args: { folderId: FOLDER_ID, maxResults: 100 },
    invariants: {
      // Name and ID as ONE entry, in the file-entry shape: separately, the ID
      // could come from a Link line and the title from a same-named copy. A doc
      // on a shared drive carries " (Shared Drive)" after its name.
      matches: [
        /^Contents of folder \(\d+ items?\):/,
        new RegExp(`^📄 ${escapeRegExp(DOC_TITLE)}(?: \\(Shared Drive\\))?\\n   ID: ${escapeRegExp(DOC_ID)}\\n`, 'm'),
      ],
      excludes: ["The folder is empty or you don't have permission"],
    },
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
