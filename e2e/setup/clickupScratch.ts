// Setup/teardown for ClickUp write tests.
//
// Scoped to a dedicated scratch LIST (E2E_CLICKUP_SCRATCH_LIST_ID) inside a
// dedicated scratch SPACE (E2E_CLICKUP_SCRATCH_SPACE_ID) in the write
// workspace. The list is the ClickUp analogue of e2e-scratch/: cleanup only
// ever enumerates tasks in that one list, so a mis-set env var can't reach real
// work. The space id is only needed by tests that create their own throwaway
// list (createList / deleteList regressions).
//
// Naming convention matches the Google side — `[e2e] <label> <ISO>` — so an
// orphan is obvious in the ClickUp UI if teardown ever misses.

import { getClickUpWriteClient } from './clickupClient.ts';
import { scratchName, isScratchName, required } from './scratchNaming.ts';

const DOC = 'e2e/fixtures/write-clickup.md';

export function scratchListId(): string {
  return required('E2E_CLICKUP_SCRATCH_LIST_ID', DOC);
}

export function scratchSpaceId(): string {
  return required('E2E_CLICKUP_SCRATCH_SPACE_ID', DOC);
}

export interface ScratchTask {
  id: string;
  name: string;
}

export async function createScratchTask(label: string, description?: string): Promise<ScratchTask> {
  const client = getClickUpWriteClient();
  const name = scratchName(label);
  const created = await client.request<{ id?: string }>(
    'POST',
    `/list/${scratchListId()}/task`,
    { name, description },
  );
  if (!created.id) throw new Error('ClickUp POST /list/:id/task returned no task id');
  return { id: created.id, name };
}

/** A throwaway list inside the scratch space, for createList/deleteList cases. */
export async function createScratchList(label: string): Promise<{ id: string; name: string }> {
  const client = getClickUpWriteClient();
  const name = scratchName(label);
  const created = await client.request<{ id?: string }>(
    'POST',
    `/space/${scratchSpaceId()}/list`,
    { name },
  );
  if (!created.id) throw new Error('ClickUp POST /space/:id/list returned no list id');
  return { id: created.id, name };
}

export async function deleteTask(taskId: string): Promise<void> {
  await getClickUpWriteClient().request('DELETE', `/task/${taskId}`);
}

export async function deleteList(listId: string): Promise<void> {
  await getClickUpWriteClient().request('DELETE', `/list/${listId}`);
}

export async function listScratchTaskNames(): Promise<string[]> {
  const client = getClickUpWriteClient();
  const res = await client.request<{ tasks?: Array<{ name?: string }> }>(
    'GET',
    `/list/${scratchListId()}/task?subtasks=true&include_closed=true`,
  );
  return (res.tasks ?? []).map((t) => t.name ?? '');
}

/**
 * Safety net mirroring cleanupScratchFolder() — delete every `[e2e]`-prefixed
 * task in the scratch list. Double-scoped (container + name prefix) for the
 * same reason as the Drive sweep: cleanup is destructive and env vars get
 * mistyped.
 *
 * Deleting shifts ClickUp's pagination underneath us, so instead of walking
 * pages forward we re-read the first page until a pass finds nothing left to
 * delete. MAX_PASSES bounds it so a task we lack permission to delete turns
 * into a loud failure instead of a spin.
 */
const MAX_PASSES = 20;

export async function cleanupScratchList(): Promise<void> {
  const client = getClickUpWriteClient();
  const listId = scratchListId();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const res = await client.request<{ tasks?: Array<{ id?: string; name?: string }> }>(
      'GET',
      `/list/${listId}/task?subtasks=true&include_closed=true`,
    );
    const stale = (res.tasks ?? []).filter(
      (t): t is { id: string; name: string } => Boolean(t.id) && isScratchName(t.name),
    );
    if (stale.length === 0) return;
    for (const task of stale) await deleteTask(task.id);
  }

  throw new Error(
    `[e2e] cleanupScratchList gave up after ${MAX_PASSES} passes — scratch list ${listId} ` +
      'still holds [e2e] tasks. Check the API token has delete permission on that list.',
  );
}
