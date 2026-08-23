import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

const FIXTURE_FOLDER_ID = fixtureEnv('E2E_FIXTURE_DRIVE_FOLDER_ID', 'google-drive');
const FIXTURE_FILE_NEEDLE = fixtureEnv('E2E_FIXTURE_DRIVE_NEEDLE', 'google-drive');

test(`listFolderContents returns fixture folder listing (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'listFolderContents',
    service: 'google-drive',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the listFolderContents MCP tool with folderId "${FIXTURE_FOLDER_ID}".`,
      outputContract('the name of every item the tool returned, one per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_FILE_NEEDLE],
    },
  });
});
