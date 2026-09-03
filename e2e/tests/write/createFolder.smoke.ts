import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { createScratchFolder, trashFile, cleanupScratchFolder } from '../../setup/scratchFactory.ts';
import { scratchMarker, scratchName } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchFolder();
});

test(`createFolder creates a folder under the scratch parent (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'createFolder',
    service: 'google-drive',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      // The MCP creates the folder under a parent WE own inside e2e-scratch/,
      // so the new folder is inside the swept tree even if teardown dies.
      const parentId = await createScratchFolder('drive write parent');
      const marker = scratchMarker('drive');
      return { parentId, marker, folderName: scratchName(`drive write ${marker}`) };
    },
    prompt: ({ parentId, folderName }) =>
      [
        `Call the createFolder MCP tool with name "${folderName}" and parentFolderId "${parentId}".`,
        `Then call the listFolderContents MCP tool with folderId "${parentId}".`,
        outputContract('the name of every item listFolderContents returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    teardown: async ({ parentId }) => {
      // Trashing the parent trashes the folder the MCP created inside it.
      await trashFile(parentId);
    },
  });
});
