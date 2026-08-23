// Setup/teardown helpers for the Drive-backed Google write tests — Docs,
// Sheets, Slides, and Drive itself. Every scratch resource is created inside
// the e2e-scratch/ folder of the write Google account, so cleanup is scoped and
// never touches anything outside that folder.
//
// Gmail and Calendar are NOT Drive-backed and have no folder to scope to; they
// get their own factories (setup/gmailScratch.ts, setup/calendarScratch.ts)
// that sweep by the `[e2e]` name prefix instead.
//
// Naming convention lives in setup/scratchNaming.ts: `[e2e] <label> <ISO>`, so
// stray resources are recognizable in the Drive UI if teardown ever misses.

import { getWriteAccountClients } from './googleClient.ts';
import { scratchName } from './scratchNaming.ts';

const SCRATCH_FOLDER_ID_ENV = 'E2E_SCRATCH_FOLDER_ID';

export function scratchFolderId(): string {
  const value = process.env[SCRATCH_FOLDER_ID_ENV];
  if (!value) {
    throw new Error(
      `Missing ${SCRATCH_FOLDER_ID_ENV}. See e2e/fixtures/write-google.md for the setup procedure.`,
    );
  }
  return value;
}

/** Reparent a freshly created Drive-backed file into e2e-scratch/. */
async function moveIntoScratch(fileId: string): Promise<void> {
  const { drive } = getWriteAccountClients();
  await drive.files.update({
    fileId,
    addParents: scratchFolderId(),
    fields: 'id, parents',
  });
}

export async function createScratchDoc(label: string, body: string): Promise<string> {
  const { docs } = getWriteAccountClients();

  const created = await docs.documents.create({
    requestBody: { title: scratchName(label) },
  });
  const docId = created.data.documentId;
  if (!docId) throw new Error('docs.documents.create returned no documentId');

  await moveIntoScratch(docId);

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

export async function createScratchSheet(label: string, rows?: string[][]): Promise<string> {
  const { sheets } = getWriteAccountClients();

  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title: scratchName(label) } },
  });
  const sheetId = created.data.spreadsheetId;
  if (!sheetId) throw new Error('sheets.spreadsheets.create returned no spreadsheetId');

  await moveIntoScratch(sheetId);

  if (rows?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  return sheetId;
}

/**
 * Slides decks are created via the Slides API (not Drive) so the deck comes
 * with a default slide the write test can target.
 */
export async function createScratchPresentation(label: string): Promise<string> {
  const { slides } = getWriteAccountClients();

  const created = await slides.presentations.create({
    requestBody: { title: scratchName(label) },
  });
  const presentationId = created.data.presentationId;
  if (!presentationId) throw new Error('slides.presentations.create returned no presentationId');

  await moveIntoScratch(presentationId);
  return presentationId;
}

/** First slide's objectId — the anchor a batchUpdatePresentation write targets. */
export async function firstSlideId(presentationId: string): Promise<string> {
  const { slides } = getWriteAccountClients();
  const res = await slides.presentations.get({ presentationId });
  const objectId = res.data.slides?.[0]?.objectId;
  if (!objectId) throw new Error(`Presentation ${presentationId} has no slides`);
  return objectId;
}

/**
 * Sub-folder inside e2e-scratch/. The google-drive write smoke asks the MCP to
 * create a folder under this parent, so the created folder lands inside the
 * scratch tree and gets swept by cleanupScratchFolder().
 */
export async function createScratchFolder(label: string): Promise<string> {
  const { drive } = getWriteAccountClients();

  const created = await drive.files.create({
    requestBody: {
      name: scratchName(label),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [scratchFolderId()],
    },
    fields: 'id',
  });
  const folderId = created.data.id;
  if (!folderId) throw new Error('drive.files.create returned no folder id');
  return folderId;
}

/** List names of the direct children of a folder — used by drive assertions. */
export async function listFolderChildNames(folderId: string): Promise<string[]> {
  const { drive } = getWriteAccountClients();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });
  return (res.data.files ?? []).map((f) => f.name ?? '');
}

export async function trashFile(fileId: string): Promise<void> {
  const { drive } = getWriteAccountClients();
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

/**
 * Safety net — trash everything inside e2e-scratch/, recursively (trashing a
 * folder trashes its descendants). Called from afterAll in test files to clean
 * up anything per-test teardown missed.
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
