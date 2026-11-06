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
      // Name and ID together, in the file-entry shape: the ID alone could also
      // appear in a Link line, and the title alone in a same-named copy.
      includes: [`📄 ${DOC_TITLE}`, `   ID: ${DOC_ID}\n`],
      matches: [/^Contents of folder \(\d+ items?\):/],
      excludes: ["The folder is empty or you don't have permission"],
    },
  });
});
