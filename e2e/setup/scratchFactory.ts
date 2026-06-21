// Setup/teardown helpers for write tests. Every scratch resource is created
// inside the e2e-scratch/ folder of the write Google account, so cleanup is
// scoped and never touches anything outside that folder.
//
// Naming convention: scratch resources get a `[e2e]` prefix and a timestamp so
// stray resources are recognizable in the Drive UI if teardown ever misses.

import { getWriteAccountClients } from './googleClient.ts';

const SCRATCH_FOLDER_ID_ENV = 'E2E_SCRATCH_FOLDER_ID';

function scratchFolderId(): string {
  const value = process.env[SCRATCH_FOLDER_ID_ENV];
  if (!value) {
    throw new Error(
      `Missing ${SCRATCH_FOLDER_ID_ENV}. See e2e/fixtures/write.md for the setup procedure.`,
    );
  }
  return value;
}

function scratchName(label: string): string {
  return `[e2e] ${label} ${new Date().toISOString()}`;
}

export async function createScratchDoc(label: string, body: string): Promise<string> {
  const { docs, drive } = getWriteAccountClients();

  const created = await docs.documents.create({
    requestBody: { title: scratchName(label) },
  });
  const docId = created.data.documentId;
  if (!docId) throw new Error('docs.documents.create returned no documentId');

  // Move into the scratch folder.
  await drive.files.update({
    fileId: docId,
    addParents: scratchFolderId(),
    fields: 'id, parents',
  });

  if (body) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          { insertText: { location: { index: 1 }, text: body } },
        ],
      },
    });
  }

  return docId;
}

export async function createScratchSheet(label: string): Promise<string> {
  const { sheets, drive } = getWriteAccountClients();

  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title: scratchName(label) } },
  });
  const sheetId = created.data.spreadsheetId;
  if (!sheetId) throw new Error('sheets.spreadsheets.create returned no spreadsheetId');

  await drive.files.update({
    fileId: sheetId,
    addParents: scratchFolderId(),
    fields: 'id, parents',
  });

  return sheetId;
}

export async function trashFile(fileId: string): Promise<void> {
  const { drive } = getWriteAccountClients();
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

/**
 * Safety net — trash everything inside e2e-scratch/. Called from afterAll in
 * test files to clean up anything per-test teardown missed.
 */
export async function cleanupScratchFolder(): Promise<void> {
  const { drive } = getWriteAccountClients();
  const folderId = scratchFolderId();

  // Drive's list API caps at 1000 per page; in practice a scratch folder
  // should never approach that, but we paginate anyway in case teardown was
  // broken for a while and litter accumulated.
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
    });
    const files = res.data.files ?? [];
    for (const file of files) {
      if (file.id) await trashFile(file.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}
