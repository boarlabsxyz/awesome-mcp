// src/clickup/restWrites.ts
//
// Body schemas and ops for the ClickUp REST write plane. Both the schema and the
// op are shared with nothing else today, but they live here rather than in
// `webServer.ts` for the reason the Calendar pass learned the hard way: a handler
// that rebuilds the upstream body itself drifts from the MCP tool that builds the
// same body, silently. Everything that decides *what the request is* lives in one
// place; the route keeps only its status codes and error mapping.
//
// TWO BODY CONTRACTS EXIST ON THIS SERVICE, deliberately:
//
//   * The routes catalogued here take the MCP tools' own camelCase parameters
//     (`dueDate`, `markdownContent`, `taskTypeId`), because they are new and can
//     therefore match the tool exactly — which is what keeps the two surfaces
//     from drifting on what is valid.
//   * The OLDER ClickUp write routes in `webServer.ts` (POST /lists/{id}/tasks,
//     PATCH /tasks/{id}, POST /spaces/{id}, …) take ClickUp-NATIVE snake_case
//     bodies (`due_date`, `custom_item_id`, `comment_text`, `tid`, `parent`) and
//     forward them verbatim. That is not an oversight to clean up: it is the
//     contract `public/openapi-clickup.json` has published for a long time, so
//     validating those paths with the camelCase schemas below would 400 every
//     generated client. They keep their own paths and their own shape.
//
// This is why the update/delete routes here sit on explicit ACTION paths
// (`/tasks/{id}/update`) instead of adding a POST verb beside the legacy PATCH on
// the bare resource path: one path must mean one body shape, or the two contracts
// above become indistinguishable at the call site.
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { ClickUpClient } from './apiHelpers.js';
import { getImagePublicBaseUrl } from '../images/imageBlobStore.js';
import { assertOneImageSource, isImageUrlOnOurHost, storeImageFromArgs } from './docImageIngest.js';

// === Tasks ===

/**
 * The camelCase fields of a ClickUp task update, with the descriptions the LLM
 * reads. Declared as a field OBJECT rather than a schema so the two surfaces can
 * compose it differently without copying it: the MCP tool adds `taskId` as a
 * parameter, the REST route takes it from the path. Copying instead would let the
 * surfaces drift on what is valid, which is the whole reason this module exists.
 */
export const taskUpdateFields = {
  name: z.string().optional().describe('New task name.'),
  description: z.string().optional().describe('New description (plain text). Use markdownContent instead for formatted text.'),
  markdownContent: z.string().optional().describe('New description in markdown format. Takes precedence over description. Supports bold, italic, code blocks, lists, etc.'),
  status: z.string().optional().describe('New status name.'),
  priority: z.number().int().min(1).max(4).nullable().optional().describe('Priority: 1=Urgent, 2=High, 3=Normal, 4=Low, null=none.'),
  dueDate: z.string().optional().describe('New due date as ISO string or Unix timestamp in ms.'),
  startDate: z.string().optional().describe('New start date as ISO string or Unix timestamp in ms.'),
  addAssignees: z.array(z.number()).optional().describe('User IDs to add as assignees.'),
  removeAssignees: z.array(z.number()).optional().describe('User IDs to remove from assignees.'),
  timeEstimate: z.number().int().optional().describe('Time estimate in milliseconds.'),
  archived: z.boolean().optional().describe('Archive or unarchive the task.'),
  taskTypeId: z.number().int().min(0).optional().describe(
    'Task type (ClickUp custom item type) as a number: 0 = Task (the default), 1 = Milestone, and workspace-specific types above that. Call listTaskTypes to resolve a name like "Bug" to its number. Changing the type changes which custom fields apply to the task.',
  ),
  // `.nullable()` and deliberately NOT `.min(1)`: a Zod-level rejection surfaces
  // as a generic "expected string, received null", which is the unexplained
  // failure this parameter exists to replace. Letting null through is what buys
  // the explanation. ClickUp cannot clear a parent, so null is refused, not sent.
  parentTaskId: z.string().nullable().optional().describe(
    'Re-parent this task: move it under a different parent task in place, keeping its ID, comments, history and custom field values. '
    + 'Its own subtasks come along. Must be a ClickUp internal task ID (custom task IDs are not supported here). '
    + 'ClickUp cannot convert a subtask back into a top-level task, so null is rejected with an explanation rather than sent. '
    + 'Issue a re-parent as its own updateTask call: ClickUp applies the PUT atomically, so if it rejects the parent, the other fields in the same call are lost too.'
  ),
} as const;

/**
 * Body of POST /api/v1/clickup/tasks/{taskId}/update (path supplies taskId).
 *
 * The `.refine` is REST-only, matching updateListRestSchema: an empty body would
 * send an empty update, which ClickUp answers 200 with the unchanged task — a
 * no-op that reads as a successful update. Note `{ parentTaskId: null }` PASSES
 * this check (null is a defined value), on purpose: the op owns that refusal, and
 * its explanation is the whole reason the field is `.nullable()`.
 */
export const updateTaskRestSchema = z.object(taskUpdateFields).refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'Provide at least one field to update.' },
);

export type UpdateTaskRestArgs = z.infer<typeof updateTaskRestSchema>;

/**
 * Build ClickUp's native update body from the camelCase parameters.
 *
 * Shared with nothing yet, but kept separate from the request so the field
 * mapping (`dueDate` → `due_date`, the `assignees: {add, rem}` object ClickUp
 * requires rather than a flat array) is stated once.
 */
export function buildTaskUpdateBody(args: UpdateTaskRestArgs, parentId?: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  // markdownContent wins over description, matching the MCP tool: sending both
  // lets ClickUp decide, and it does not reliably prefer the formatted one.
  if (args.markdownContent !== undefined) data.markdown_content = args.markdownContent;
  else if (args.description !== undefined) data.description = args.description;
  if (args.status !== undefined) data.status = args.status;
  if (args.priority !== undefined) data.priority = args.priority;
  if (args.dueDate !== undefined) data.due_date = new Date(args.dueDate).getTime();
  if (args.startDate !== undefined) data.start_date = new Date(args.startDate).getTime();
  if (args.addAssignees || args.removeAssignees) {
    data.assignees = { add: args.addAssignees || [], rem: args.removeAssignees || [] };
  }
  if (args.timeEstimate !== undefined) data.time_estimate = args.timeEstimate;
  if (args.archived !== undefined) data.archived = args.archived;
  if (args.taskTypeId !== undefined) data.custom_item_id = args.taskTypeId;
  if (parentId !== undefined) data.parent = parentId;
  return data;
}

/**
 * Update a task, and on the re-parent path verify the change actually landed.
 *
 * The verification is not optional polish. ClickUp answers a parent change it
 * silently ignores with HTTP 200 and emits no webhook for a parent change at
 * all, so a stale PUT echo is indistinguishable from success — reporting it as
 * success is the exact bug the MCP tool's re-parent path exists to prevent, and
 * a REST caller has even less recourse. `reparentConfirmed` is therefore
 * three-valued: true, false (ClickUp disagrees — do NOT treat the move as done),
 * or null (the confirming read failed, so this is the requested state only).
 */
export async function performUpdateTask(
  client: ClickUpClient,
  taskId: string,
  args: UpdateTaskRestArgs,
): Promise<{ task: any; reparentConfirmed: boolean | null }> {
  const selfTaskId = taskId.trim();
  let requestedParentId: string | undefined;
  if (args.parentTaskId !== undefined) {
    if (args.parentTaskId === null) {
      throw new UserError(
        'parentTaskId cannot be null. ClickUp does not support converting a subtask back into a top-level task by '
        + 'clearing `parent` — the field only accepts a valid task ID, so a subtask can be moved under a different '
        + 'parent but never detached.',
      );
    }
    requestedParentId = args.parentTaskId.trim();
    if (requestedParentId === '') {
      throw new UserError('parentTaskId must be a non-empty ClickUp task ID. Omit the field to leave the parent unchanged.');
    }
    if (requestedParentId === selfTaskId) {
      throw new UserError(`parentTaskId (${requestedParentId}) is the same as taskId — a task cannot be its own parent.`);
    }
  }

  const echo = await client.updateTask(taskId, buildTaskUpdateBody(args, requestedParentId));
  if (!requestedParentId) return { task: echo, reparentConfirmed: null };

  // Best-effort by design: a failed confirmation must never turn a move that did
  // happen into an error, so the outcome is reported as unconfirmed instead.
  let verified: any = null;
  try { verified = await client.getTask(taskId); } catch { /* reported as null below */ }
  if (!verified) return { task: echo, reparentConfirmed: null };
  return { task: verified, reparentConfirmed: verified.parent === requestedParentId };
}

/** Shared camelCase fields of a ClickUp list update. See taskUpdateFields. */
export const listUpdateFields = {
  name: z.string().optional().describe('New name for the list.'),
  content: z.string().optional().describe('New description/content.'),
  dueDate: z.string().optional().describe('New due date as ISO string.'),
  priority: z.number().int().min(1).max(4).optional().describe('Priority: 1=Urgent, 2=High, 3=Normal, 4=Low.'),
} as const;

/**
 * Body of POST /api/v1/clickup/lists/{listId}/update (path supplies listId).
 *
 * The `.refine` is REST-only: an empty body here would be a silent no-op answered
 * 200, whereas the MCP tool's caller gets the same outcome reported in prose.
 */
export const updateListRestSchema = z.object(listUpdateFields).refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'Provide at least one field to update (name, content, dueDate, or priority).' },
);

export async function performUpdateList(
  client: ClickUpClient,
  listId: string,
  args: z.infer<typeof updateListRestSchema>,
): Promise<any> {
  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  if (args.content !== undefined) data.content = args.content;
  if (args.dueDate !== undefined) data.due_date = new Date(args.dueDate).getTime();
  if (args.priority !== undefined) data.priority = args.priority;
  return client.updateList(listId, data);
}

// === Tasks in Multiple Lists ===
//
// The MCP tools wrap these with a pre-flight that reads the task and the list
// first, so a 401 can be attributed to the "Tasks in Multiple Lists" ClickApp
// being switched off rather than to a bad credential. That pre-flight is
// error-message quality for an LLM, not an integrity check, and it is NOT
// reproduced here — the same call the uncatalogued PATCH /tasks/{id} route makes
// about its own guards. What is reproduced is the part a caller cannot supply
// itself: ClickUp answers both writes 200 with an EMPTY body, so without a
// re-read the write is unobservable. `locations` is returned as evidence when
// ClickUp sends it; its ABSENCE is not evidence of absence (that is what a
// disabled ClickApp looks like), hence `confirmed: null` rather than false.

export async function performTaskListMembership(
  client: ClickUpClient,
  direction: 'add' | 'remove',
  taskId: string,
  listId: string,
): Promise<{ taskId: string; listId: string; confirmed: boolean | null; homeListId: string | null; locations: string[] | null }> {
  if (direction === 'add') await client.addTaskToList(listId, taskId);
  else await client.removeTaskFromList(listId, taskId);

  let task: any = null;
  try { task = await client.getTask(taskId); } catch { /* unconfirmed below */ }
  const raw = Array.isArray(task?.locations) ? task.locations : null;
  const locations = raw ? raw.map((l: any) => String(l?.id ?? l)) : null;
  const present = locations ? locations.includes(listId) : null;
  return {
    taskId,
    listId,
    confirmed: present === null ? null : (direction === 'add' ? present : !present),
    homeListId: task?.list?.id != null ? String(task.list.id) : null,
    locations,
  };
}

// === Docs and pages ===

/** Shared camelCase fields of a ClickUp doc creation. See taskUpdateFields. */
export const createDocFields = {
  name: z.string().min(1).describe('Title of the new doc.'),
  content: z.string().optional().describe('Initial content of the doc (markdown supported).'),
  parentId: z.string().optional().describe('ID of the parent (Space, Folder, or List) to place the doc in.'),
  // NOT the same parameter as searchDocs.parentType, despite the name: this one
  // is a numeric code in the POST body, that one is a string filter in the query
  // string. Do not "unify" them.
  parentType: z.number().optional().describe('Type of parent: 4 = Space, 5 = Folder, 6 = List. Required if parentId is provided.'),
} as const;

/**
 * Body of POST /api/v1/clickup/workspaces/{workspaceId}/docs.
 *
 * The `.refine` is REST-only: the MCP tool states the requirement in its
 * description and silently ignores a lone parentId, which over curl would read as
 * "the doc was not placed where I asked" with nothing saying why.
 */
export const createDocRestSchema = z.object(createDocFields).refine(
  (v) => v.parentId === undefined || v.parentType !== undefined,
  {
    message: 'parentType (4 = Space, 5 = Folder, 6 = List) is required when parentId is provided.',
    path: ['parentType'],
  },
);

/**
 * Create a doc and, when content was supplied, write it to the doc's first page.
 *
 * The second step is required rather than cosmetic: ClickUp's createDoc endpoint
 * IGNORES a content field, so a single call returns a doc whose body is empty.
 * `contentWritten` is reported because the doc exists either way — a failure here
 * is partial success, and answering with an error would invite a retry that makes
 * a second doc.
 */
export async function performCreateDoc(
  client: ClickUpClient,
  workspaceId: string,
  args: z.infer<typeof createDocRestSchema>,
): Promise<{ doc: any; contentWritten: boolean | null }> {
  const data: { name: string; parent?: { id: string; type: number } } = { name: args.name };
  if (args.parentId && args.parentType !== undefined) {
    data.parent = { id: args.parentId, type: args.parentType };
  }
  const doc = await client.createDoc(workspaceId, data);
  if (!args.content) return { doc, contentWritten: null };

  try {
    const pagesResult: any = await client.getDocPages(workspaceId, doc.id);
    const pages = pagesResult?.pages || pagesResult?.data || pagesResult || [];
    if (Array.isArray(pages) && pages.length > 0) {
      await client.editPage(workspaceId, doc.id, pages[0].id, {
        content: args.content, content_format: 'text/md', content_edit_mode: 'replace',
      });
    } else {
      await client.createPage(workspaceId, doc.id, {
        name: args.name, content: args.content, content_format: 'text/md',
      });
    }
    return { doc, contentWritten: true };
  } catch {
    return { doc, contentWritten: false };
  }
}

/** Shared camelCase fields of a ClickUp doc page creation. See taskUpdateFields. */
export const createPageFields = {
  name: z.string().optional().describe('Name of the new page.'),
  content: z.string().optional().describe('Content of the page (markdown).'),
  parentPageId: z.string().optional().describe('ID of the parent page for nesting.'),
} as const;

export const createPageRestSchema = z.object(createPageFields);

export async function performCreatePage(
  client: ClickUpClient,
  workspaceId: string,
  docId: string,
  args: z.infer<typeof createPageRestSchema>,
): Promise<any> {
  const data: Record<string, unknown> = {};
  if (args.name) data.name = args.name;
  if (args.content) { data.content = args.content; data.content_format = 'text/md'; }
  if (args.parentPageId) data.parent_page_id = args.parentPageId;
  return client.createPage(workspaceId, docId, data);
}

/** Shared camelCase fields of a ClickUp doc page edit. See taskUpdateFields. */
export const editPageFields = {
  name: z.string().optional().describe('New name for the page.'),
  content: z.string().optional().describe('New content (markdown).'),
  editMode: z.enum(['replace', 'append', 'prepend']).optional().default('replace')
    .describe('How to apply content: replace (default), append, or prepend.'),
} as const;

/** Body of the page-edit route. The `.refine` is REST-only; see createDocRestSchema. */
export const editPageRestSchema = z.object(editPageFields).refine(
  (v) => v.name !== undefined || v.content !== undefined,
  { message: 'Provide name, content, or both.' },
);

export async function performEditPage(
  client: ClickUpClient,
  workspaceId: string,
  docId: string,
  pageId: string,
  args: z.infer<typeof editPageRestSchema>,
): Promise<{ pageId: string; editMode: string }> {
  const data: Record<string, unknown> = {};
  if (args.name) data.name = args.name;
  if (args.content) {
    data.content = args.content;
    data.content_format = 'text/md';
    data.content_edit_mode = args.editMode || 'replace';
  }
  await client.editPage(workspaceId, docId, pageId, data);
  return { pageId, editMode: args.editMode || 'replace' };
}

/**
 * Shared camelCase fields of a ClickUp doc page image insert.
 *
 * Note what is NOT here and must never be added: a filesystem path. Over stdio a
 * local path is a feature because the caller owns the machine; over REST the
 * caller is anyone holding a credential, including the permanent dashboard API
 * key, so the same parameter is a server file-read primitive.
 */
export const insertImageFields = {
  imageUrl: z.string().optional().describe('Public http(s) URL of the image (jpg, png, gif, bmp, or webp; max 20 MB). Provide exactly one of imageUrl or imageBase64; prefer imageUrl when a public URL exists.'),
  imageBase64: z.string().optional().describe('Base64-encoded image bytes (a data:...;base64, prefix is accepted and stripped). For SMALL images only — ~100KB ideal, hard limit ~1.5 MB decoded — because the payload consumes the calling model context. Provide exactly one of imageUrl or imageBase64.'),
  fileName: z.string().optional().describe('Optional filename, used only for error messages/logging. NOT used to determine the image format (magic bytes decide).'),
  altText: z.string().optional().default('').describe('Alt text for the image.'),
  editMode: z.enum(['append', 'prepend', 'replace']).optional().default('append')
    .describe('How to place the image: append (default), prepend, or replace the page content.'),
  skipRehost: z.boolean().optional().default(false)
    .describe('Embed imageUrl as-is without fetching/re-hosting it (applies to imageUrl only). Auto-enabled when imageUrl is already on this server.'),
} as const;

export const insertImageRestSchema = z.object(insertImageFields);

/**
 * Re-host an image and embed it in a page as markdown.
 *
 * `imageUrl` is fetched BY THIS SERVER, which makes it an SSRF surface the moment
 * anyone holding an API key can set it — and on this plane that includes the
 * permanent dashboard key. The fetch therefore goes through `storeImageFromArgs`
 * → `fetchImageBytes`, which validates every redirect hop; nothing here may fetch
 * the URL itself. Note the schema takes no filesystem path, and must not grow
 * one: a server-side path parameter would be a file-read primitive over REST even
 * though it is a feature over stdio.
 */
export async function performInsertImageIntoPage(
  client: ClickUpClient,
  workspaceId: string,
  docId: string,
  pageId: string,
  args: z.infer<typeof insertImageRestSchema>,
): Promise<{ pageId: string; editMode: string; url: string }> {
  // Fail fast if the image host isn't configured, before spending a fetch.
  //
  // Re-tagged as 503 rather than left to become a 500: nothing is broken, the
  // deployment simply has no IMAGE_PUBLIC_BASE_URL, and a 500 tells the caller to
  // report a bug when the fix is a config value. getImagePublicBaseUrl throws a
  // plain Error, so without this it is indistinguishable from a real fault.
  let publicBase: string;
  try {
    publicBase = getImagePublicBaseUrl();
  } catch (err: any) {
    const wrapped: any = new Error(
      `Image hosting is not configured on this server, so an image cannot be re-hosted for a ClickUp Doc. `
      + `IMAGE_PUBLIC_BASE_URL (and DATABASE_URL) must be set. ${err?.message ?? err}`,
    );
    // Named rather than merely given a .status, because sendUpstreamError only
    // special-cases 404 and 403 and would collapse anything else to 500. The
    // route matches on this name to answer 503.
    wrapped.name = 'ServiceNotConfiguredError';
    wrapped.status = 503;
    throw wrapped;
  }
  assertOneImageSource(args);

  const url = (args.imageUrl && (args.skipRehost || isImageUrlOnOurHost(args.imageUrl, publicBase)))
    ? args.imageUrl
    : await storeImageFromArgs(args);

  const editMode = args.editMode || 'append';
  // No orphan cleanup on failure: image_blobs is content-addressed and deduped,
  // so the blob may be shared with another doc and deleting it could break it.
  await client.editPage(workspaceId, docId, pageId, {
    content: `![${args.altText || ''}](${url})`,
    content_format: 'text/md',
    content_edit_mode: editMode,
  });
  return { pageId, editMode, url };
}
