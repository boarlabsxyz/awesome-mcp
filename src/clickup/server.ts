// src/clickup/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  ClickUpClient,
  clickUpErrorStatus,
  clickUpErrorWasAnswered,
  collectTasksInCloseWindow,
  cursorFromEnvelope,
  DOCS_MAX_PAGES,
  docsFromEnvelope,
  formatCloseWindowCapMessage,
  markdownToCommentBlocks,
  parseCloseWindow,
  parseTimestampInput,
} from './apiHelpers.js';
import { formatTask, formatTaskList } from './formatHelpers.js';
import {
  CustomFieldDefinition,
  CustomFieldValueError,
  needsFieldLookup,
  prepareCustomFieldValue,
} from './customFieldValue.js';
import { getImagePublicBaseUrl } from '../images/imageBlobStore.js';
import {
  assertOneImageSource,
  isImageUrlOnOurHost,
  storeImageFromArgs,
} from './docImageIngest.js';
// The camelCase write-parameter fields are defined ONCE in ./restWrites.js and
// composed by both surfaces: the tools below add the id as a parameter, the REST
// routes take it from the path. Copying them would let the two drift on what is
// valid, which is exactly what the shared definition prevents.
import {
  createDocFields,
  createPageFields,
  editPageFields,
  insertImageFields,
  listUpdateFields,
  taskUpdateFields,
} from './restWrites.js';
import {
  CAPTURED_EVENTS,
  debugTaskEventSubscriptionFlow,
  queryTaskEventsFlow,
  subscribeToTaskEventsFlow,
} from './webhookHelpers.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

export const clickUpServer = new FastMCP<UserSession>({
  name: 'ClickUp MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'clickup'),
});

registerMintRestBearerForCurl(clickUpServer);
registerListRestEndpoints(clickUpServer);

function getClickUpClient(session?: UserSession): ClickUpClient {
  if (!session?.clickUpAccessToken) {
    throw new UserError('ClickUp not connected. Visit the dashboard to connect your ClickUp account.');
  }
  return new ClickUpClient(session.clickUpAccessToken);
}

// The image ingest path (base64 decode, URL fetch with its per-hop SSRF guard,
// store(), and the already-on-our-host check) lives in ./docImageIngest.js so the
// REST data plane reuses the same one rather than growing a second copy.

// formatTask / formatCustomFieldValue / formatTaskList moved to ./formatHelpers.js
// so the REST data plane (webServer.ts) can reuse the same rendering when
// callers request `Accept: text/plain` on /api/v1/clickup/tasks/* endpoints.

// === Tier 1: Core Navigation ===

clickUpServer.addTool({
  name: 'getAuthorizedUser',
  annotations: { readOnlyHint: true },
  description: 'Get information about the currently authenticated ClickUp user. Useful for debugging connections and getting your user ID.',
  parameters: z.object({}),
  execute: async (_args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getAuthorizedUser();
    const user = result.user;
    return `ClickUp User:\n  ID: ${user.id}\n  Username: ${user.username}\n  Email: ${user.email}\n  Color: ${user.color}`;
  },
});

clickUpServer.addTool({
  name: 'listWorkspaces',
  annotations: { readOnlyHint: true },
  description: 'List all accessible ClickUp workspaces (teams). Returns workspace IDs needed for other operations.',
  parameters: z.object({}),
  execute: async (_args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getWorkspaces();
    const teams = result.teams || [];
    if (teams.length === 0) return 'No workspaces found.';
    return teams.map((t: any) =>
      `Workspace: ${t.name}\n  ID: ${t.id}\n  Members: ${t.members?.length || 0}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'listSpaces',
  annotations: { readOnlyHint: true },
  description: 'List all spaces in a ClickUp workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    archived: z.boolean().optional().default(false).describe('Include archived spaces.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getSpaces(args.workspaceId, args.archived);
    const spaces = result.spaces || [];
    if (spaces.length === 0) return 'No spaces found.';
    return spaces.map((s: any) =>
      `Space: ${s.name}\n  ID: ${s.id}\n  Private: ${s.private}\n  Statuses: ${s.statuses?.map((st: any) => st.status).join(', ') || 'none'}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'listFolders',
  annotations: { readOnlyHint: true },
  description: 'List all folders in a ClickUp space.',
  parameters: z.object({
    spaceId: z.string().describe('The space ID.'),
    archived: z.boolean().optional().default(false).describe('Include archived folders.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getFolders(args.spaceId, args.archived);
    const folders = result.folders || [];
    if (folders.length === 0) return 'No folders found in this space.';
    return folders.map((f: any) =>
      `Folder: ${f.name}\n  ID: ${f.id}\n  Lists: ${f.lists?.length || 0}\n  Task Count: ${f.task_count || 0}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'listLists',
  annotations: { readOnlyHint: true },
  description: 'List all lists in a ClickUp folder, or folderless lists in a space. Provide either folderId or spaceId.',
  parameters: z.object({
    folderId: z.string().optional().describe('The folder ID to list lists from.'),
    spaceId: z.string().optional().describe('The space ID to list folderless lists from. Used when folderId is not provided.'),
    archived: z.boolean().optional().default(false).describe('Include archived lists.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    if (!args.folderId && !args.spaceId) {
      throw new UserError('Provide either folderId or spaceId.');
    }
    const result = args.folderId
      ? await client.getListsInFolder(args.folderId, args.archived)
      : await client.getFolderlessLists(args.spaceId!, args.archived);
    const lists = result.lists || [];
    if (lists.length === 0) return 'No lists found.';
    return lists.map((l: any) =>
      `List: ${l.name}\n  ID: ${l.id}\n  Task Count: ${l.task_count || 0}\n  Status: ${l.status?.status || 'none'}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'getTask',
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific ClickUp task by its ID. Returns the FULL, untruncated '
    + 'description — use this (not the list tools, which show a bounded preview) when you need to read a ticket in '
    + 'full to summarize it, reuse it as a template, or check acceptance criteria. Reports Parent (and Top-level '
    + 'parent when nesting is deeper than one level) when the task is a subtask. ClickUp returns those as bare task '
    + 'IDs with no name — that is the payload, not missing data; call getTask on the parent ID if you need its name. '
    + 'Reports Task type when the task is not a plain Task; listTaskTypes resolves that number to a name. Custom '
    + 'Fields listed are only those applying to this task\'s type — ClickUp omits the others even when a value is '
    + 'stored, so a field missing here is NOT evidence it is empty; getAccessibleCustomFields shows which task types '
    + 'each field applies to.',
  parameters: z.object({
    taskId: z.string().describe('The task ID (e.g., "abc123" or custom task ID).'),
    includeSubtasks: z.boolean().optional().default(false).describe('Include subtasks in response.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const task = await client.getTask(args.taskId, args.includeSubtasks);
    // Single-record tool: return the description untruncated so template/
    // summarization workflows read the whole ticket, not a 200-char fragment.
    let output = formatTask(task, { fullDescription: true });
    if (args.includeSubtasks && task.subtasks?.length) {
      output += '\n\n  Subtasks:\n' + task.subtasks.map((st: any) =>
        `    - ${st.name} (${st.id}) [${st.status?.status || 'unknown'}]`
      ).join('\n');
    }
    return output;
  },
});

/**
 * Explain the rows whose `List:` line names a different list.
 *
 * listTasks passes include_timl, so the answer to "what is in this list"
 * correctly includes tasks shared in from elsewhere — but formatTask renders
 * each task's HOME list, so those rows look like they belong to some other list
 * and read as a bug. Naming them is cheaper than suppressing them and far better
 * than ClickUp's default, which is to omit them and let an empty result read as
 * "that list is empty".
 *
 * Silent when nothing is shared in, which is the overwhelmingly common case.
 */
function sharedTaskNote(tasks: any[], listId: string): string {
  const shared = tasks.filter((t) => t?.list?.id !== undefined && String(t.list.id) !== listId);
  if (shared.length === 0) return '';
  return `\n\n${shared.length} of these live in another list and appear here through Tasks in Multiple Lists, so `
    + `their List: line names their home list rather than ${listId}: `
    + `${shared.map((t) => `${t.id} (home: ${t.list.name ?? 'unnamed'})`).join(', ')}.`;
}

clickUpServer.addTool({
  name: 'listTasks',
  annotations: { readOnlyHint: true },
  description: 'List tasks in a ClickUp list with optional filters. To query tasks closed within a window, set '
    + 'closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and '
    + 'filters locally on date_closed (ClickUp\'s REST API has no server-side close-date filter). Each task reports '
    + 'its Parent ID when it is a subtask, so a hierarchy can be rebuilt from one call instead of a getTask per node; '
    + 'match that ID against the IDs already in this response rather than looking each one up (ClickUp includes no '
    + 'parent name). Set subtasks=true or children are omitted entirely. Tasks shared into this list from another '
    + 'home list (Tasks in Multiple Lists) ARE included by default — their List: line names their home list, not '
    + 'this one; set includeMultiListTasks=false for only the tasks that live here.',
  parameters: z.object({
    listId: z.string().describe('The list ID to get tasks from.'),
    archived: z.boolean().optional().default(false).describe('Include archived tasks.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based). Each page returns up to 100 tasks. Ignored when closedAfter/closedBefore is set.'),
    orderBy: z.enum(['id', 'created', 'updated', 'due_date']).optional().describe('Field to order by.'),
    reverse: z.boolean().optional().default(false).describe('Reverse the order.'),
    subtasks: z.boolean().optional().default(false).describe('Include subtasks.'),
    statuses: z.array(z.string()).optional().describe('Filter by status names.'),
    includeClosed: z.boolean().optional().default(false).describe('Include closed tasks. Automatically forced true when closedAfter/closedBefore is set.'),
    // Read as `!== false` in the body rather than trusting this default: if the
    // schema layer is ever bypassed, undefined must still mean ON, because the
    // off direction fails by silently omitting tasks that are really there.
    includeMultiListTasks: z.boolean().optional().default(true).describe(
      'Include tasks shared into this list whose home list is elsewhere (ClickUp\'s include_timl). Defaults to TRUE: '
      + 'ClickUp excludes them otherwise, so a task plainly sitting in the list reads back as absent. Set false to '
      + 'list only tasks whose home list is this one.',
    ),
    assignees: z.array(z.string()).optional().describe('Filter by assignee user IDs.'),
    closedAfter: z.string().optional().describe('Only return tasks closed at/after this time. ISO string or Unix ms. Enables auto-pagination + local date_closed filtering.'),
    closedBefore: z.string().optional().describe('Only return tasks closed at/before this time. ISO string or Unix ms. Enables auto-pagination + local date_closed filtering.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const win = parseCloseWindow(args.closedAfter, args.closedBefore);
    if (win.error) throw new UserError(win.error);

    if (win.from !== undefined || win.to !== undefined) {
      const { tasks, pagesScanned, hitCap } = await collectTasksInCloseWindow(
        async (page) => {
          const res = await client.getTasks(args.listId, {
            archived: args.archived,
            page,
            order_by: args.orderBy,
            reverse: args.reverse,
            subtasks: args.subtasks,
            statuses: args.statuses,
            include_closed: true,
            include_timl: args.includeMultiListTasks !== false,
            assignees: args.assignees,
          });
          return res.tasks || [];
        },
        win.from,
        win.to,
      );
      if (hitCap) throw new UserError(formatCloseWindowCapMessage(pagesScanned));
      return formatTaskList(tasks) + sharedTaskNote(tasks, args.listId);
    }

    const result = await client.getTasks(args.listId, {
      archived: args.archived,
      page: args.page,
      order_by: args.orderBy,
      reverse: args.reverse,
      subtasks: args.subtasks,
      statuses: args.statuses,
      include_closed: args.includeClosed,
      include_timl: args.includeMultiListTasks !== false,
      assignees: args.assignees,
    });
    return formatTaskList(result.tasks || []) + sharedTaskNote(result.tasks || [], args.listId);
  },
});

// === Tier 2: Task CRUD ===

clickUpServer.addTool({
  name: 'createTask',
  annotations: { readOnlyHint: false },
  description: 'Create a new task in a ClickUp list.',
  parameters: z.object({
    listId: z.string().describe('The list ID to create the task in.'),
    name: z.string().min(1).describe('Task name.'),
    description: z.string().optional().describe('Task description (plain text). Use markdownContent instead for formatted text.'),
    markdownContent: z.string().optional().describe('Task description in markdown format. Takes precedence over description. Supports bold, italic, code blocks, lists, etc.'),
    assignees: z.array(z.number()).optional().describe('Array of user IDs to assign.'),
    status: z.string().optional().describe('Task status name.'),
    priority: z.number().int().min(1).max(4).nullable().optional().describe('Priority: 1=Urgent, 2=High, 3=Normal, 4=Low, null=none.'),
    dueDate: z.string().optional().describe('Due date as ISO string or Unix timestamp in ms.'),
    startDate: z.string().optional().describe('Start date as ISO string or Unix timestamp in ms.'),
    tags: z.array(z.string()).optional().describe('Array of tag names.'),
    timeEstimate: z.number().int().optional().describe('Time estimate in milliseconds.'),
    parentTaskId: z.string().optional().describe('Parent task ID to create as subtask.'),
    taskTypeId: z.number().int().min(0).optional().describe(
      'Task type (ClickUp custom item type) as a number: 0 = Task (the default), 1 = Milestone, and workspace-specific types above that. Call listTaskTypes to resolve a name like "Bug" to its number. Changing the type changes which custom fields apply to the task.',
    ),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const task = await client.createTask(args.listId, {
      name: args.name,
      description: args.markdownContent ? undefined : args.description,
      markdown_content: args.markdownContent,
      assignees: args.assignees,
      status: args.status,
      priority: args.priority,
      due_date: args.dueDate ? new Date(args.dueDate).getTime() : undefined,
      start_date: args.startDate ? new Date(args.startDate).getTime() : undefined,
      tags: args.tags,
      time_estimate: args.timeEstimate,
      parent: args.parentTaskId,
      custom_item_id: args.taskTypeId,
    });
    return `Task created successfully:\n${formatTask(task)}`;
  },
});

clickUpServer.addTool({
  name: 'updateTask',
  annotations: { readOnlyHint: false },
  description: 'Update an existing ClickUp task. Only provided fields will be changed. '
    + 'Also RE-PARENTS a task: pass parentTaskId to move a subtask under a different parent while keeping its ID, '
    + 'comments, history and custom fields, so restructuring a hierarchy never needs tasks to be recreated. '
    + 'The re-parent is verified: the tool reads the target parent first (to resolve its name and list), applies the '
    + 'change, then re-reads the task and reports the confirmed parent, so no follow-up getTask is needed — and if '
    + 'ClickUp silently ignores the change it says so instead of claiming success. It also reports the parent\'s list '
    + 'and the task\'s list, so the response tells you what ClickUp did about a cross-list parent. '
    + 'Note ClickUp emits NO webhook event for a parent change, so getTaskEventHistory will never show one; this '
    + 'response is the only record. moveTask changes a task\'s LIST, not its parent — the two are independent.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to update.'),
    ...taskUpdateFields,
  }),
  execute: async (args, { session, log }) => {
    const client = getClickUpClient(session);

    // Re-parent input is validated before anything is sent. `parentTaskId` is
    // deliberately `.nullable()` and NOT `.min(1)`: a Zod-level rejection
    // surfaces as FastMCP's generic InvalidParams ("Expected string, received
    // null"), which is the unexplained failure this parameter exists to
    // replace. Letting null reach here is what buys the explanation.
    // One normalised identity for this task, used by every comparison below.
    // The self-reference and cycle checks exist purely to produce a specific
    // message instead of ClickUp's generic rejection, so they must agree on
    // what "the same task" means -- comparing a trimmed ID in one and a raw one
    // in the other would silently downgrade a cycle to the generic error.
    const selfTaskId = args.taskId.trim();
    let requestedParentId: string | undefined;
    if (args.parentTaskId !== undefined) {
      if (args.parentTaskId === null) {
        throw new UserError(
          'parentTaskId cannot be null. ClickUp does not support converting a subtask back into a top-level task by '
          + 'clearing `parent` — the field only accepts a valid task ID, so a subtask can be moved under a different '
          + 'parent but never detached. Detaching means recreating the task at top level (losing its comments and '
          + 'history) or doing it in the ClickUp UI.',
        );
      }
      requestedParentId = args.parentTaskId.trim();
      if (requestedParentId === '') {
        throw new UserError(
          'parentTaskId must be a non-empty ClickUp task ID. Omit the field to leave the parent unchanged — an '
          + 'empty string is not a way to clear it.',
        );
      }
      if (requestedParentId === selfTaskId) {
        throw new UserError(`parentTaskId (${requestedParentId}) is the same as taskId — a task cannot be its own parent.`);
      }
    }

    // Pre-flight, on the re-parent path only. ClickUp's task payload carries
    // `parent` as a bare ID with no name anywhere, so this read is the only
    // source for the name the response confirms with. It also yields the
    // parent's list (the cross-list observation below) and turns an unknown or
    // inaccessible ID into a message that names it, instead of the raw 400 body
    // request() would otherwise surface (it has no 400/404 special-casing).
    // Safe to throw from: nothing has been mutated yet.
    let resolvedParent: any = null;
    if (requestedParentId) {
      try {
        resolvedParent = await client.getTask(requestedParentId);
      } catch (err: any) {
        const raw = String(err?.message || err);
        // ClickUp answers a task ID it cannot resolve with 401 "Team not
        // authorized" (OAUTH_027) -- the same shape a revoked token produces.
        // Passing that through verbatim sends the caller off to re-issue a
        // credential that was never the problem, so say plainly what it almost
        // always means and keep the raw body for the rare case it does not.
        const looksLikeNotFound = /OAUTH_027|Team not authorized|\b404\b/i.test(raw);
        throw new UserError(
          `Cannot re-parent: parent task ${requestedParentId} was not found or is not visible to this connection, `
          + `so nothing was changed on ${args.taskId}. Check the ID is a ClickUp internal task ID in a workspace this `
          + `connection can see — custom task IDs are not supported here.`
          + (looksLikeNotFound
            ? ` (ClickUp reports an unknown task ID as 401 "Team not authorized"/OAUTH_027, which looks like an auth `
              + `failure but is not — the token is fine if other ClickUp tools are working.)`
            : '')
          + ` ClickUp said: ${raw}`,
        );
      }
      if (!resolvedParent?.id) {
        throw new UserError(`Cannot re-parent: ClickUp returned no task for parent ID ${requestedParentId}. Nothing was changed.`);
      }
      // Cheap cycle check. One getTask only sees the candidate's immediate
      // parent and its root, so a cycle deeper than that still relies on
      // ClickUp's own rejection (wrapped below); an exhaustive guard would be an
      // O(depth) ancestor walk for a hierarchy ClickUp caps at 7 levels.
      if (resolvedParent.parent === selfTaskId || resolvedParent.top_level_parent === selfTaskId) {
        throw new UserError(
          `Cannot re-parent: ${requestedParentId} ("${resolvedParent.name}") is already a descendant of `
          + `${selfTaskId}. Making it the parent would create a cycle. Nothing was changed.`,
        );
      }
    }

    const data: any = {};
    if (args.name !== undefined) data.name = args.name;
    if (args.markdownContent !== undefined) {
      data.markdown_content = args.markdownContent;
    } else if (args.description !== undefined) {
      data.description = args.description;
    }
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
    // Send the ID ClickUp itself echoed, not the raw argument, so the
    // verification compare below is against a canonical value.
    if (resolvedParent) data.parent = resolvedParent.id;

    let echo: any;
    try {
      echo = await client.updateTask(args.taskId, data);
    } catch (err: any) {
      if (!resolvedParent) throw err;
      throw new UserError(
        `Re-parenting ${args.taskId} under ${resolvedParent.id} ("${resolvedParent.name}") was rejected by ClickUp. `
        + `The PUT is atomic, so any other fields in this call were most likely not applied either — re-read with `
        + `getTask before retrying. The parent lives in list "${resolvedParent.list?.name}" (${resolvedParent.list?.id}). `
        + `ClickUp said: ${err?.message || err}`,
      );
    }

    // Archive confirmation. formatTask surfaces `archived` only when true, so a
    // successful unarchive would otherwise be indistinguishable from a no-op --
    // and before this the archive direction said nothing either. Read it off the
    // PUT echo; when ClickUp omits the key, report it unconfirmed rather than
    // asserting a state we never saw.
    let archiveNote = '';
    if (args.archived !== undefined) {
      const want = args.archived;
      if (echo && typeof echo.archived === 'boolean') {
        archiveNote = echo.archived === want
          ? `\n\n${want ? 'Archived' : 'Unarchived'} — confirmed by ClickUp.`
          : `\n\n⚠ Requested archived=${want} but ClickUp reports archived=${echo.archived}. The change did not take effect.`;
      } else {
        archiveNote = `\n\nRequested archived=${want}. ClickUp's response did not include the flag, so this is `
          + `unconfirmed — call getTask to check.`;
      }
    }

    // Everything below is the re-parent path. A plain update stays exactly one
    // API call and returns exactly the string it always did.
    if (!resolvedParent) return `Task updated successfully:\n${formatTask(echo)}${archiveNote}`;

    // Re-read rather than trusting the PUT echo: a stale echo would let a silent
    // no-op read as success, which is the failure this parameter exists to
    // remove. Best-effort: a failed verification must never turn a move that
    // did happen into an error.
    let verified: any = null;
    try { verified = await client.getTask(args.taskId); } catch { /* reported below */ }

    // Operator breadcrumb. ClickUp emits no webhook for a parent change, so this
    // and the response are the only records the move happened. It also records
    // echo-vs-re-read agreement, which is the evidence needed before anyone
    // considers dropping the verification read.
    log.info(
      `[clickup-reparent] task=${args.taskId} parent=${resolvedParent.id} echoParent=${String(echo?.parent)} `
      + `readParent=${String(verified?.parent)} parentList=${String(resolvedParent.list?.id)} `
      + `taskList=${String(verified?.list?.id)}`,
    );

    const parentLabel = `"${resolvedParent.name}" (${resolvedParent.id})`;

    if (!verified) {
      return `Task updated successfully:\n${formatTask(echo)}\n\nParent set to ${parentLabel}. ClickUp returned 200 on `
        + `the update, but the follow-up verification read failed — this is the requested state, not a confirmed one. `
        + `Call getTask("${args.taskId}") to confirm.`;
    }

    if (verified.parent !== resolvedParent.id) {
      return `⚠ Re-parent did NOT take effect. ClickUp accepted the update (HTTP 200) but ${args.taskId} still `
        + `reports parent ${JSON.stringify(verified.parent ?? null)}, not the requested ${parentLabel}. ClickUp emits `
        + `neither an error nor a webhook for a rejected parent change, so this silent no-op is the only signal — do `
        + `not treat the move as done. Other fields in this call may have applied. Current state:\n${formatTask(verified)}`;
    }

    // Cross-list observation. ClickUp's docs do not say whether a parent in
    // another list is allowed or what happens to the child's list, so the tool
    // reports what actually happened rather than asserting a rule.
    const parentListId = resolvedParent.list?.id;
    const taskListId = verified.list?.id;
    const crossList = parentListId && taskListId && parentListId !== taskListId
      ? `\n  ⚠ The parent is in a different list — ClickUp accepted a cross-list parent and left this task where `
        + `it was. Use moveTask if you want them co-located.`
      : '';

    return `Task updated successfully:\n${formatTask(verified)}\n\nRe-parent confirmed: now a subtask of ${parentLabel}.`
      + `\n  Parent's list: ${resolvedParent.list?.name ?? 'unknown'} (${parentListId ?? 'unknown'})`
      + `\n  This task's list: ${verified.list?.name ?? 'unknown'} (${taskListId ?? 'unknown'})${crossList}${archiveNote}`;
  },
});

clickUpServer.addTool({
  name: 'deleteTask',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a ClickUp task permanently.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to delete.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.deleteTask(args.taskId);
    return `Task ${args.taskId} deleted successfully.`;
  },
});

clickUpServer.addTool({
  name: 'moveTask',
  annotations: { readOnlyHint: false },
  description: 'Move a task to a different LIST. This does NOT change the task\'s parent: a subtask moved to '
    + 'another list stays a subtask of the same parent task. To re-parent a task (move a subtask under a different '
    + 'parent task), use updateTask with parentTaskId instead.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to move.'),
    listId: z.string().describe('The destination list ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.moveTask(args.taskId, args.listId);
    return `Task ${args.taskId} moved to list ${args.listId}.`;
  },
});

// === Tasks in Multiple Lists ===
//
// ClickUp's two multi-list endpoints share one diagnostic problem, and these
// helpers are the whole of the fix. `POST`/`DELETE /list/{listId}/task/{taskId}`
// answer 401 when the "Tasks in Multiple Lists" ClickApp is switched off -- the
// SAME status ClickUp returns for a revoked token and for an ID it cannot
// resolve (OAUTH_027 "Team not authorized"; see the re-parent pre-flight in
// updateTask), with nothing in the body separating the four cases. A bare
// "ClickUp API error (401)" therefore sends the user to re-issue a credential
// that works perfectly, which is the failure being reported. Since the response
// cannot be read to tell which cause it is, the only honest route is to rule the
// others out first: read the task, read the list, and only then attribute a 401
// to the ClickApp -- and say so only when the status actually looks like one.
//
// Add and remove are deliberately driven through ONE set of helpers below,
// parameterised by direction. The two tools differ only in a verb and in which
// membership they expect afterwards; duplicating the pre-flight, the error
// attribution and the four-way verdict would mean the honesty rules could drift
// apart between them, which is the one thing this code exists to guarantee.

const UNRESOLVED_ID_401_NOTE =
  'ClickUp reports an ID it cannot resolve as 401 "Team not authorized"/OAUTH_027, which reads like an auth failure '
  + 'but is not — the connection is fine if other ClickUp tools are working.';

const MULTI_LIST_CLICKAPP_NOTE =
  'This is almost certainly the "Tasks in Multiple Lists" ClickApp being switched off: ClickUp answers a disabled '
  + 'ClickApp with 401, which reads as an authentication failure, but this call had already read both the task and '
  + 'the list successfully — so neither the connection nor either ID is the problem. A Workspace owner or admin '
  + 'enables it in ClickUp under Settings → ClickApps → "Tasks in Multiple Lists"; it can also be toggled per Space, '
  + 'so check the Space containing this list. Sharing a SUBTASK into another list needs the separate "Subtasks in '
  + 'Multiple Lists" ClickApp as well.';

/** Which way a multi-list write is going. The two tools differ only in this. */
type MultiListAction = 'add' | 'remove';

const MULTI_LIST_VERBS: Record<MultiListAction, {
  tool: string; bare: string; gerund: string; preposition: string;
}> = {
  add: { tool: 'addTaskToList', bare: 'add', gerund: 'adding', preposition: 'to' },
  remove: { tool: 'removeTaskFromList', bare: 'remove', gerund: 'removing', preposition: 'from' },
};

/**
 * The lists a task has been shared into, per ClickUp's `locations`.
 *
 * Returns undefined -- not [] -- when the payload carries no array, because
 * "shared into nothing" and "ClickUp did not tell us" must not lead to the same
 * decision: the first is safe to act on (refuse a duplicate add, refuse a
 * pointless remove), the second is absence of evidence and has to fall through
 * to the API and let the 401 path explain itself.
 */
function taskLocationIds(task: any): string[] | undefined {
  if (!Array.isArray(task?.locations)) return undefined;
  return task.locations.filter((l: any) => l?.id !== undefined).map((l: any) => String(l.id));
}

/**
 * Hard gate for both multi-list tools: resolve the task and the list before
 * anything is mutated.
 *
 * Three jobs, all load-bearing. It attributes a bad ID to the ID that is bad
 * instead of leaving the caller to guess which of the two arguments ClickUp
 * objected to; it is the only source of the two NAMES the confirmation quotes,
 * since these endpoints answer with an empty body; and by proving the connection
 * can read both, it is what earns the right to blame a later 401 on the
 * ClickApp. Safe to throw from -- nothing has been sent yet.
 */
async function resolveMultiListTargets(
  client: ClickUpClient,
  taskId: string,
  listId: string,
  action: string,
): Promise<{ task: any; list: any }> {
  let task: any;
  try {
    task = await client.getTask(taskId);
  } catch (err: any) {
    throw new UserError(
      `Cannot ${action}: task ${taskId} was not found or is not visible to this connection, so nothing was changed. `
      + `Check it is a ClickUp internal task ID — custom task IDs are not supported here. ${UNRESOLVED_ID_401_NOTE} `
      + `ClickUp said: ${String(err?.message || err)}`,
    );
  }
  if (!task?.id) {
    throw new UserError(`Cannot ${action}: ClickUp returned no task for ID ${taskId}. Nothing was changed.`);
  }
  let list: any;
  try {
    list = await client.getList(listId);
  } catch (err: any) {
    throw new UserError(
      `Cannot ${action}: list ${listId} was not found or is not visible to this connection, so nothing was changed. `
      + `Use listLists to find the list ID. ${UNRESOLVED_ID_401_NOTE} ClickUp said: ${String(err?.message || err)}`,
    );
  }
  if (!list?.id) {
    throw new UserError(`Cannot ${action}: ClickUp returned no list for ID ${listId}. Nothing was changed.`);
  }
  return { task, list };
}

/**
 * Turn a failed multi-list write into one message, without overclaiming.
 *
 * The line that matters is not whether ClickUp answered but whether it answered
 * that it REFUSED. Only a 4xx is a refusal, and only then is "the task was not
 * changed" a fact. Everything else leaves the outcome genuinely UNKNOWN, and
 * that covers two cases that feel different and are not:
 *
 *   - no answer at all (timeout, dropped connection) — the failure can land
 *     after ClickUp has already applied the write;
 *   - an answered 5xx — a 500 can be raised after the write committed, and a
 *     502/504 is usually a proxy that never learned the outcome either.
 *
 * Reporting either as "not changed" is the same class of lie as reporting a
 * silent no-op as success, which is the failure this whole module exists to
 * remove. The ClickApp note stays pinned to an answered 401 specifically, never
 * to a transport failure or a 5xx body that merely mentions one.
 */
function multiListWriteError(
  action: MultiListAction,
  err: unknown,
  taskId: string,
  taskLabel: string,
  listLabel: string,
): UserError {
  const verbs = MULTI_LIST_VERBS[action];
  const raw = String((err as any)?.message || err);
  const attempt = `${verbs.gerund} task ${taskLabel} ${verbs.preposition} list ${listLabel}`;
  const status = clickUpErrorStatus(err);
  const refused = clickUpErrorWasAnswered(err) && status !== undefined && status < 500;

  if (!refused) {
    const cause = status === undefined
      ? 'failed before ClickUp answered'
      : `was answered with ${status}, a server-side error that does not say whether the write was applied`;
    return new UserError(
      `The request ${attempt} ${cause}, so the outcome is UNKNOWN — ClickUp may or may not have applied it. Do not `
      + `retry blindly: call getTask("${taskId}") and check whether the list is listed, then retry only if it is `
      + `not. ClickUp said: ${raw}`,
    );
  }

  return new UserError(
    `ClickUp refused ${attempt} (HTTP ${status}); the task was not changed. `
    + (status === 401 ? `${MULTI_LIST_CLICKAPP_NOTE} ` : '') + `ClickUp said: ${raw}`,
  );
}

/**
 * Re-read the task after a successful write and report what is actually true.
 *
 * Both endpoints answer 200 with an empty body, so without this a silent no-op
 * is indistinguishable from success — the same reasoning as the re-parent
 * verification in updateTask. The verdict is four-way rather than two because
 * collapsing them would turn a write that DID happen into an error: a failed
 * re-read reports the requested state, a payload with no `locations` array
 * reports unconfirmed, and only a payload that actually disagrees is reported as
 * not having taken effect.
 *
 * The home-list case is called out separately on the add path. `locations` not
 * containing the list while the task's home list IS that list means the task was
 * moved rather than shared — which these tools explicitly do not promise — so
 * counting it as presence would misreport a concurrent moveTask as a successful
 * share.
 */
async function reportMultiListOutcome(
  client: ClickUpClient,
  action: MultiListAction,
  taskId: string,
  listId: string,
  taskLabel: string,
  listLabel: string,
  homeList: { name?: string; id?: string },
): Promise<string> {
  const verbs = MULTI_LIST_VERBS[action];
  const accepted = `ClickUp accepted ${verbs.gerund} task ${taskLabel} ${verbs.preposition} list ${listLabel} (HTTP 200)`;

  let verified: any;
  try {
    verified = await client.getTask(taskId);
  } catch {
    return `${accepted}, but the follow-up verification read failed — this is the requested state, not a confirmed `
      + `one. Call getTask("${taskId}") to confirm.`;
  }

  const ids = taskLocationIds(verified);
  if (!ids) {
    // Deliberately does NOT blame the ClickApp: the write returned 200, which a
    // disabled ClickApp would not have. The cause is unknown, so the message
    // reports what is and is not known rather than inventing one.
    return `${accepted}, but the follow-up read returned no list-membership data at all, so this is the requested `
      + `state rather than a confirmed one. Call getTask("${taskId}") or open the list in ClickUp to check.`
      + `\n\n${formatTask(verified)}`;
  }

  const inAdditional = ids.includes(listId);
  const isHome = String(verified.list?.id) === listId;

  if (action === 'add') {
    if (inAdditional) {
      return `Task ${taskLabel} added to list ${listLabel}. It remains in its home list `
        + `"${homeList.name ?? 'unknown'}" (${homeList.id ?? 'unknown'}).\n\n${formatTask(verified)}`;
    }
    if (isHome) {
      return `⚠ Task ${taskLabel} now reports ${listLabel} as its HOME list, not as an additional one. That is a `
        + `move, not the share this tool performs, so something else changed the task concurrently — do not treat `
        + `this as a confirmed multi-list membership. Current state:\n${formatTask(verified)}`;
    }
    return `⚠ The add did NOT take effect. ${accepted} but task ${taskLabel} still does not list ${listLabel} among `
      + `its lists. ClickUp reports no error for this, so a silent no-op is the only signal — do not treat the task `
      + `as shared. Current state:\n${formatTask(verified)}`;
  }

  if (!inAdditional && !isHome) {
    return `Task ${taskLabel} removed from list ${listLabel}. The task itself was not deleted and still lives in `
      + `"${verified.list?.name ?? homeList.name ?? 'unknown'}" (${verified.list?.id ?? homeList.id ?? 'unknown'}).`
      + `\n\n${formatTask(verified)}`;
  }
  return `⚠ The removal did NOT take effect. ${accepted} but task ${taskLabel} still lists ${listLabel}`
    + (isHome ? ' (as its home list)' : '') + `. ClickUp reports no error for this, so a silent no-op is the only `
    + `signal — do not treat the task as removed. Current state:\n${formatTask(verified)}`;
}

/**
 * The parameters both multi-list tools take.
 *
 * Shared rather than written twice because the two are token-identical, and
 * because the home-list rule belongs in ONE place: it constrains both
 * directions, just for opposite reasons — ClickUp cannot remove a task from its
 * home list, and adding a task to its own home list is a no-op it answers 200
 * to. The per-direction wording lives in each tool's description instead.
 */
const MULTI_LIST_PARAMS = z.object({
  taskId: z.string().min(1).describe(
    'The task whose additional-list membership changes. Must be a ClickUp internal task ID — custom task IDs are '
    + 'not supported here.',
  ),
  listId: z.string().min(1).describe(
    'The ADDITIONAL list (from listLists), never the task\'s own home list. The home list is not a valid target in '
    + 'either direction: ClickUp cannot remove a task from it, and adding a task to it changes nothing.',
  ),
});

/**
 * Everything both multi-list tools do before they diverge: acquire the client
 * (which is also the auth guard), normalise the two IDs, leave the breadcrumb,
 * and run the hard-gate pre-flight.
 *
 * Shared rather than written twice so the pre-flight can never be skipped on one
 * path -- it is what earns the right to blame a later 401 on the ClickApp, so a
 * tool that quietly lost it would start reporting a credential problem again.
 */
async function beginMultiListWrite(
  session: UserSession | undefined,
  log: { info: (msg: string) => void },
  args: { taskId: string; listId: string },
  action: MultiListAction,
): Promise<{
  client: ClickUpClient; taskId: string; listId: string;
  task: any; list: any; taskLabel: string; listLabel: string;
}> {
  const client = getClickUpClient(session);
  const taskId = args.taskId.trim();
  const listId = args.listId.trim();
  const verbs = MULTI_LIST_VERBS[action];
  log.info(`${verbs.tool} task=${taskId} list=${listId}`);
  const { task, list } = await resolveMultiListTargets(
    client, taskId, listId,
    `${verbs.bare} task ${taskId} ${verbs.preposition} list ${listId}`,
  );
  return {
    client, taskId, listId, task, list,
    taskLabel: `${taskId} ("${task.name ?? 'unnamed'}")`,
    listLabel: `"${list.name ?? 'unnamed'}" (${listId})`,
  };
}

clickUpServer.addTool({
  name: 'addTaskToList',
  annotations: { readOnlyHint: false },
  description: 'Add an existing task to an ADDITIONAL ClickUp list while it stays in its current list (the Tasks in '
    + 'Multiple Lists ClickApp). Use moveTask instead to relocate a task rather than share it into a second place.',
  parameters: MULTI_LIST_PARAMS,
  execute: async (args, { session, log }) => {
    const { client, taskId, listId, task, taskLabel, listLabel } = await beginMultiListWrite(session, log, args, 'add');

    // Both no-op cases are reported rather than sent. ClickUp accepts them and
    // answers 200 with an empty body, so calling through would report a share
    // that never happened -- and for the home list there is no share to make.
    if (String(task.list?.id) === listId) {
      return `Nothing to do: ${listLabel} is already the home list of task ${taskLabel}, not an additional one. `
        + `Pass a different list to share the task into, or use moveTask to relocate it.`;
    }
    if (taskLocationIds(task)?.includes(listId)) {
      return `Nothing to do: task ${taskLabel} is already in list ${listLabel}.\n\n${formatTask(task)}`;
    }

    try {
      await client.addTaskToList(listId, taskId);
    } catch (err: any) {
      throw multiListWriteError('add', err, taskId, taskLabel, listLabel);
    }
    log.info(`[clickup-multilist] add task=${taskId} list=${listId}`);
    return reportMultiListOutcome(client, 'add', taskId, listId, taskLabel, listLabel, task.list ?? {});
  },
});

clickUpServer.addTool({
  name: 'removeTaskFromList',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a task from one of its ADDITIONAL ClickUp lists (Tasks in Multiple Lists). The task itself is '
    + 'not deleted and stays in its home list, which ClickUp will not let you remove it from.',
  parameters: MULTI_LIST_PARAMS,
  execute: async (args, { session, log }) => {
    const { client, taskId, listId, task, taskLabel, listLabel } = await beginMultiListWrite(session, log, args, 'remove');

    // ClickUp documents that a task cannot be removed from its home list, so
    // this is refused with the reason instead of spending a call on a rejection
    // whose 401/400 body would land back in the ClickApp ambiguity above.
    if (String(task.list?.id) === listId) {
      return `Refused: ${listLabel} is the home list of task ${taskLabel}, and ClickUp cannot remove a task from `
        + `its home list — only from additional ones. Use moveTask to send it to a different list, or deleteTask to `
        + `delete it. Nothing was changed.`;
    }
    // Only acted on when ClickUp actually told us the memberships; see
    // taskLocationIds on why an absent array is not evidence of absence.
    const existing = taskLocationIds(task);
    if (existing && !existing.includes(listId)) {
      return `Nothing to do: task ${taskLabel} is not in list ${listLabel}. Its lists: `
        + `home "${task.list?.name ?? 'unknown'}" (${task.list?.id ?? 'unknown'})`
        + (existing.length ? `, additional ${existing.join(', ')}` : ', no additional lists')
        + `. Nothing was changed.`;
    }

    try {
      await client.removeTaskFromList(listId, taskId);
    } catch (err: any) {
      throw multiListWriteError('remove', err, taskId, taskLabel, listLabel);
    }
    log.info(`[clickup-multilist] remove task=${taskId} list=${listId}`);
    return reportMultiListOutcome(client, 'remove', taskId, listId, taskLabel, listLabel, task.list ?? {});
  },
});

clickUpServer.addTool({
  name: 'addTaskComment',
  annotations: { readOnlyHint: false },
  description: 'Add a comment to a ClickUp task. Supports markdown formatting: **bold**, *italic*, `inline code`.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to comment on.'),
    commentText: z.string().min(1).describe('The comment text. Supports markdown: **bold**, *italic*, `inline code`.'),
    assignee: z.number().optional().describe('User ID to assign (if creating an assigned comment).'),
    notifyAll: z.boolean().optional().default(true).describe('Notify all assignees and watchers.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const comment = markdownToCommentBlocks(args.commentText);
    const result = await client.addTaskComment(args.taskId, {
      comment,
      assignee: args.assignee,
      notify_all: args.notifyAll,
    });
    return `Comment added to task ${args.taskId}. Comment ID: ${result.id}`;
  },
});

clickUpServer.addTool({
  name: 'getTaskComments',
  annotations: { readOnlyHint: true },
  description: 'Get comments on a ClickUp task.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to get comments for.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getTaskComments(args.taskId);
    const comments = result?.comments || [];
    if (comments.length === 0) return 'No comments on this task.';
    return comments.map((c: any) => {
      const author = c.user?.username || c.user?.email || 'unknown';
      const date = c.date ? new Date(parseInt(c.date)).toISOString() : 'unknown date';
      const text = c.comment_text
        || (Array.isArray(c.comment) ? c.comment.map((p: any) => p.text || '').join('') : '')
        || '[empty]';
      // Return the full comment text. This is the only comments tool, so
      // truncating silently (previously at 300 chars, with no ellipsis or
      // length signal) dropped thread content with no way for the caller to
      // tell — the same silent-truncation failure fixed for getTask.
      return `Comment by ${author} (${date}):\n  ${text}`;
    }).join('\n\n');
  },
});

// === Tier 3: Search ===

clickUpServer.addTool({
  name: 'filterTeamTasks',
  annotations: { readOnlyHint: true },
  description: 'Query tasks across a ClickUp workspace using ClickUp\'s server-side "Get Filtered Team Tasks" endpoint (GET /api/v2/team/{team_id}/task). One paginated call replaces per-list enumeration for workspace-wide digests. Returns tasks the caller can access (naturally scoped by the OAuth identity), 100 per page — iterate `page` from 0 to fetch all. Supports assignees, statuses, tags, scope narrowing (spaceIds/projectIds/listIds), and date ranges on date_created / date_updated / due_date. IMPORTANT: ClickUp does NOT support date_closed / date_done filters or a close-date sort here — for "closed since T", query with `dateUpdatedGt=T` (closing bumps date_updated, so this is a superset) and partition on each task\'s `date_closed` client-side.'
    + ' Each task reports its Parent ID when it is a subtask (a bare ID, no name — ClickUp does not include one), '
    + 'so hierarchies can be rebuilt from one page. Set subtasks=true or children are omitted entirely.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    assignees: z.array(z.string()).optional().describe('Filter to tasks assigned to any of these user IDs.'),
    statuses: z.array(z.string()).optional().describe('Filter to tasks in any of these status names.'),
    tags: z.array(z.string()).optional().describe('Filter to tasks with any of these tag names.'),
    spaceIds: z.array(z.string()).optional().describe('Narrow to tasks in these space IDs.'),
    projectIds: z.array(z.string()).optional().describe('Narrow to tasks in these folder (project) IDs.'),
    listIds: z.array(z.string()).optional().describe(
      'Narrow to tasks whose HOME list is one of these IDs. ClickUp\'s Get Filtered Team Tasks has no include_timl '
      + 'parameter, so a task shared into one of these lists from elsewhere (Tasks in Multiple Lists) is NOT matched '
      + 'and cannot be — use listTasks for a list\'s complete membership.',
    ),
    dateCreatedGt: z.string().optional().describe('Only tasks created at/after this time. ISO string or Unix ms.'),
    dateCreatedLt: z.string().optional().describe('Only tasks created at/before this time. ISO string or Unix ms.'),
    dateUpdatedGt: z.string().optional().describe('Only tasks updated at/after this time. ISO string or Unix ms. Use as a superset for "closed since T" queries — closing a task bumps date_updated.'),
    dateUpdatedLt: z.string().optional().describe('Only tasks updated at/before this time. ISO string or Unix ms.'),
    dueDateGt: z.string().optional().describe('Only tasks with due_date at/after this time. ISO string or Unix ms.'),
    dueDateLt: z.string().optional().describe('Only tasks with due_date at/before this time. ISO string or Unix ms.'),
    orderBy: z.enum(['id', 'created', 'updated', 'due_date']).optional().describe('Sort field. No server-side close-date sort — sort client-side if needed.'),
    reverse: z.boolean().optional().default(false).describe('Reverse the sort order.'),
    subtasks: z.boolean().optional().default(false).describe('Include subtasks in results.'),
    includeClosed: z.boolean().optional().default(false).describe('Include closed/completed tasks.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based). 100 tasks per page. Omit to start at page 0; iterate until a page returns fewer than 100.'),
    custom_fields: z.array(z.object({
      field_id: z.string().describe('The custom field ID.'),
      operator: z.enum(['=', '<', '>', '>=', '<=', '!=', 'IS NULL', 'IS NOT NULL', 'RANGE', 'ANY', 'ALL', 'NOT ANY', 'NOT ALL']).describe('Comparison operator.'),
      value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional().describe('Value to compare against. Use an array for ANY/ALL. For dropdown fields, use the option UUID (id from getAccessibleCustomFields), not orderindex or label.'),
    })).optional().describe('Filter by custom fields.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const parseTs = (input: string | undefined, field: string): number | undefined => {
      if (!input) return undefined;
      const ts = parseTimestampInput(input);
      if (Number.isNaN(ts)) throw new UserError(`Invalid ${field}: ${input}`);
      return ts;
    };
    const result = await client.filterTeamTasks(args.workspaceId, {
      page: args.page,
      order_by: args.orderBy,
      reverse: args.reverse,
      subtasks: args.subtasks,
      include_closed: args.includeClosed,
      assignees: args.assignees,
      statuses: args.statuses,
      tags: args.tags,
      space_ids: args.spaceIds,
      project_ids: args.projectIds,
      list_ids: args.listIds,
      date_created_gt: parseTs(args.dateCreatedGt, 'dateCreatedGt'),
      date_created_lt: parseTs(args.dateCreatedLt, 'dateCreatedLt'),
      date_updated_gt: parseTs(args.dateUpdatedGt, 'dateUpdatedGt'),
      date_updated_lt: parseTs(args.dateUpdatedLt, 'dateUpdatedLt'),
      due_date_gt: parseTs(args.dueDateGt, 'dueDateGt'),
      due_date_lt: parseTs(args.dueDateLt, 'dueDateLt'),
      custom_fields: args.custom_fields,
    });
    const tasks = result.tasks || [];
    if (tasks.length === 0) return 'No tasks found matching filters.';
    return `Found ${tasks.length} task(s):\n\n` + tasks.map((t: any) => formatTask(t)).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'searchTasks',
  annotations: { readOnlyHint: true },
  description: 'Search for tasks across a ClickUp workspace. Supports filtering by name (client-side substring match) and/or custom fields. By default excludes closed/completed tasks — set includeClosed=true to include them. To query tasks closed within a window, set closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and filters locally on date_closed (ClickUp\'s REST API has no server-side close-date filter).'
    + ' Each task reports its Parent ID when it is a subtask (a bare ID, no name — ClickUp does not include one), '
    + 'so hierarchies can be rebuilt from one page.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID to search in.'),
    query: z.string().describe('Filter by task name (case-insensitive substring match). Use empty string to skip name filtering.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based). Results limited to 100 per page. Ignored when closedAfter/closedBefore is set.'),
    includeClosed: z.boolean().optional().default(false).describe('Include closed/completed tasks in results. Automatically forced true when closedAfter/closedBefore is set.'),
    custom_fields: z.array(z.object({
      field_id: z.string().describe('The custom field ID.'),
      operator: z.enum(['=', '<', '>', '>=', '<=', '!=', 'IS NULL', 'IS NOT NULL', 'RANGE', 'ANY', 'ALL', 'NOT ANY', 'NOT ALL']).describe('Comparison operator.'),
      value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional().describe('Value to compare against. Use an array for ANY/ALL operators. For dropdown fields, use the option UUID (id from getAccessibleCustomFields), not orderindex or label.'),
    })).optional().describe('Filter by custom fields. Each entry needs field_id, operator, and optionally value.'),
    closedAfter: z.string().optional().describe('Only return tasks closed at/after this time. ISO string or Unix ms. Enables auto-pagination + local date_closed filtering.'),
    closedBefore: z.string().optional().describe('Only return tasks closed at/before this time. ISO string or Unix ms. Enables auto-pagination + local date_closed filtering.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const win = parseCloseWindow(args.closedAfter, args.closedBefore);
    if (win.error) throw new UserError(win.error);

    if (win.from !== undefined || win.to !== undefined) {
      // Pass empty query to bypass client.searchTasks's client-side name filter so
      // the loop's "page < 100 → stop" heuristic sees the raw ClickUp page size,
      // not the name-filtered subset. We re-apply the name filter after collecting.
      const { tasks, pagesScanned, hitCap } = await collectTasksInCloseWindow(
        async (page) => {
          const res = await client.searchTasks(args.workspaceId, '', page, args.custom_fields, true);
          return res.tasks || [];
        },
        win.from,
        win.to,
      );
      if (hitCap) throw new UserError(formatCloseWindowCapMessage(pagesScanned));
      const q = args.query.toLowerCase();
      const filtered = args.query ? tasks.filter((t: any) => t.name?.toLowerCase().includes(q)) : tasks;
      if (filtered.length === 0) return `No tasks found${args.query ? ` matching "${args.query}"` : ''} closed in window.`;
      return `Found ${filtered.length} task(s) closed in window:\n\n` + filtered.map((t) => formatTask(t)).join('\n\n');
    }

    const result = await client.searchTasks(args.workspaceId, args.query, args.page, args.custom_fields, args.includeClosed);
    const tasks = result.tasks || [];
    if (tasks.length === 0) return `No tasks found${args.query ? ` matching "${args.query}"` : ''}.`;
    return `Found ${tasks.length} task(s):\n\n` + tasks.map((t: any) => formatTask(t)).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'listTaskTypes',
  annotations: { readOnlyHint: true },
  description: 'List the task types (custom item types) in a ClickUp workspace. Use this to resolve a task type name like "Bug" to the numeric taskTypeId that createTask and updateTask take.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session, log }) => {
    const client = getClickUpClient(session);
    log.info(`listTaskTypes workspace=${args.workspaceId}`);
    const result = await client.getCustomItems(args.workspaceId);
    const custom = Array.isArray(result?.custom_items) ? result.custom_items : [];
    // ClickUp's endpoint returns only the workspace's CUSTOM types. Listing
    // just those would read as "this workspace has no Task type", so the two
    // built-ins are prepended -- they are what createTask/updateTask fall back
    // to and 0 is the value that resets a task to a plain Task.
    const lines = [
      'Task (0) — the default; pass 0 to reset a task to a plain Task',
      'Milestone (1) — built in',
      ...custom.map((c: any) => {
        const desc = c?.description ? ` — ${c.description}` : '';
        return `${c?.name ?? 'unnamed'} (${c?.id})${desc}`;
      }),
    ];
    return `Found ${lines.length} task type(s) (2 built-in + ${custom.length} custom):\n\n`
      + lines.map((l) => `  ${l}`).join('\n')
      + `\n\nPass the number as taskTypeId on createTask or updateTask.`;
  },
});

/**
 * Render one task-type ID from a custom field's `applied_objects`.
 *
 * Only the two built-ins get names: ClickUp's field payload carries type IDs and
 * no names anywhere, exactly like `custom_item_id` on a task, so resolving the
 * rest would cost a workspace lookup this tool has no team ID for. Same call
 * formatTask makes — print the number and point at listTaskTypes.
 */
function describeTaskTypeId(id: number): string {
  if (id === 0) return 'Task (0, the default)';
  if (id === 1) return 'Milestone (1)';
  return String(id);
}

clickUpServer.addTool({
  name: 'getAccessibleCustomFields',
  annotations: { readOnlyHint: true },
  description: 'List all custom fields available on a ClickUp list. Use this to discover field IDs for filtering or '
    + 'setting values. Read-only by necessity: ClickUp\'s public API can set and clear a field\'s VALUE on a task '
    + '(setCustomFieldValue / removeCustomFieldValue) but has no endpoint to create a field, rename one, change its '
    + 'type, or add drop-down or label options — those are only possible in the ClickUp UI, so do not offer to do '
    + 'them here.',
  parameters: z.object({
    listId: z.string().describe('The list ID to get custom fields for.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getAccessibleCustomFields(args.listId);
    const fields = result.fields || [];
    if (fields.length === 0) return 'No custom fields found on this list.';
    let anyTypeScoped = false;
    const rendered = fields.map((f: any) => {
      const parts = [`Field: ${f.name}`, `  ID: ${f.id}`, `  Type: ${f.type}`];
      // Which custom task types this field applies to. This is the ONLY place
      // the omission described in the trailing note can be diagnosed from: the
      // task payload simply lacks the field, with nothing in it to say whether
      // the value is unset or the field inapplicable. An absent or empty array
      // means it applies to every type -- the scoping is opt-in.
      const applied = Array.isArray(f.applied_objects) ? f.applied_objects : [];
      const typeIds = applied.map((o: any) => o?.object_id).filter((v: any) => typeof v === 'number');
      if (typeIds.length) {
        anyTypeScoped = true;
        parts.push(`  Applies to task types: ${typeIds.map(describeTaskTypeId).join(', ')}`);
      } else {
        parts.push('  Applies to task types: all');
      }
      if (f.type_config?.options) {
        parts.push('  Options:');
        f.type_config.options.forEach((o: any) => {
          parts.push(`    - ${o.name || o.label} (id: ${o.id}, orderindex: ${o.orderindex}${o.color ? `, color: ${o.color}` : ''})`);
        });
        parts.push('  Note: For searchTasks custom_fields filter with ANY/ALL operators, use the option "id" (UUID), not orderindex or label.');
      }
      return parts.join('\n');
    }).join('\n\n');

    // Verified live 2026-09-29: a field whose applied task types exclude a
    // task's custom_item_id is absent from that task's payload ENTIRELY, even
    // when a value is stored -- and it stays matchable by the searchTasks
    // custom_fields filter, which runs server-side against the stored value. So
    // "getTask did not show it" is not evidence the value is unset, and without
    // this note the omission reads as exactly that.
    const scopingNote = anyTypeScoped
      ? `\n\nNote on the task types above: ClickUp omits a custom field from a task's payload when the field does not `
        + `apply to that task's type, EVEN IF a value is stored. So getTask/listTasks/searchTasks can show none of these `
        + `fields on a task that really has values set, and the value is still matched by the searchTasks custom_fields `
        + `filter. Check the task's own type (formatTask prints "Task type" for anything but the default 0) against the `
        + `types listed here before concluding a field is empty. Call listTaskTypes to resolve these numbers to names.`
      : '';
    return `Found ${fields.length} custom field(s):\n\n` + rendered + scopingNote;
  },
});

/**
 * Best-effort read of one custom field's definition, so a value can be
 * normalised against its real TYPE before the write.
 *
 * Two GETs (task -> its list -> that list's fields), and they are spent only
 * when the value could still need them (needsFieldLookup): an array of UUIDs,
 * a number or a boolean is already in ClickUp's shape, so the ordinary set
 * still costs exactly one request -- the same rule updateTask's re-parent
 * pre-flight follows.
 *
 * Deliberately NOT a hard gate. Nothing about the write depends on the lookup
 * succeeding, and refusing a set because a read 500'd would be worse than
 * falling back to the conservative string-revival path in
 * prepareCustomFieldValue. When it does fail the response says so, because a
 * labels write that silently skipped label-name resolution is the one case
 * where the degraded path can still hand ClickUp something it rejects.
 */
async function lookupCustomFieldDefinition(
  client: ClickUpClient,
  taskId: string,
  fieldId: string,
): Promise<{ definition?: CustomFieldDefinition; failure?: string }> {
  try {
    const task = await client.getTask(taskId);
    const listId = task?.list?.id;
    if (!listId) return { failure: `ClickUp returned no list for task ${taskId}` };
    const result = await client.getAccessibleCustomFields(String(listId));
    const fields: any[] = result?.fields || [];
    const definition = fields.find((f: any) => f?.id === fieldId);
    if (!definition) {
      return { failure: `field ${fieldId} is not among the custom fields accessible on list ${listId}` };
    }
    return { definition };
  } catch (err: any) {
    return { failure: String(err?.message || err) };
  }
}

clickUpServer.addTool({
  name: 'setCustomFieldValue',
  annotations: { readOnlyHint: false },
  description: 'Set a custom field value on a ClickUp task. Use getAccessibleCustomFields first to find the field ID '
    + 'and type. Value shape by field type: text/email/phone → string; number → number; checkbox → boolean; date → '
    + 'unix ms; drop_down → the option UUID or its orderindex (an option name is accepted and resolved for you); '
    + 'labels → an ARRAY of label option UUIDs (label names are accepted and resolved); users and relationship '
    + 'fields → an ARRAY of IDs, or ClickUp\'s incremental {"add": [...], "rem": [...]} object to change membership '
    + 'without replacing it. Pass an array as a real JSON array, not as its text: ClickUp answers a stringified array '
    + 'with "Value must be an array" (FIELD_144). A value that still arrives as a string is repaired here where the '
    + 'field type makes that unambiguous. NOTE: drop_down can be set by orderindex, while the searchTasks '
    + 'custom_fields filter matches only on the option UUID — getAccessibleCustomFields returns both. This endpoint '
    + 'cannot clear a field; use removeCustomFieldValue.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    fieldId: z.string().describe('The custom field ID (from getAccessibleCustomFields).'),
    // An explicit union, not z.any(). z.any() renders as the empty JSON Schema
    // `{}`, which gives a client nothing to validate an array against -- and an
    // array handed over as its JSON *text* is exactly what ClickUp rejects with
    // FIELD_144, which made every labels and users field unwritable (86cba13av).
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
      z.record(z.any()),
    ]).describe('The value to set. text=string, number=number, checkbox=boolean, date=unix ms, dropdown=option UUID '
      + 'or orderindex (an option name is also accepted), labels=array of label option UUIDs or label names, '
      + 'users/relationship=array of IDs or an {"add": [...], "rem": [...]} object. Send arrays as real JSON arrays, '
      + 'never as the text of one.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);

    let definition: CustomFieldDefinition | undefined;
    let lookupFailure: string | undefined;
    if (needsFieldLookup(args.value)) {
      ({ definition, failure: lookupFailure } = await lookupCustomFieldDefinition(
        client,
        args.taskId,
        args.fieldId,
      ));
    }

    let prepared;
    try {
      prepared = prepareCustomFieldValue(args.value, definition);
    } catch (err) {
      // Raised before anything is written, and it names the field and its real
      // options -- which the raw 400 body does not.
      if (err instanceof CustomFieldValueError) throw new UserError(err.message);
      throw err;
    }

    await client.setCustomFieldValue(args.taskId, args.fieldId, prepared.value);

    const label = definition?.name
      ? `"${definition.name}" (${definition.type}, ${args.fieldId})`
      : args.fieldId;
    const lines = [
      `Custom field ${label} updated on task ${args.taskId}.`,
      `  Sent: ${JSON.stringify(prepared.value)}`,
    ];
    prepared.notes.forEach((note) => lines.push(`  • ${note}`));
    if (lookupFailure) {
      lines.push(
        `  • Could not read the field definition (${lookupFailure}), so the value was sent with only the `
        + `string-to-JSON repair applied — option names were not resolved.`,
      );
    }
    // No re-read to confirm: ClickUp answers this POST 200 with an empty body,
    // and it omits a field from a task's payload entirely when the field does
    // not apply to that task's type, so a follow-up getTask cannot tell
    // "written" from "not applicable to this task type" and would report a
    // successful write as a failed one.
    return lines.join('\n');
  },
});

clickUpServer.addTool({
  name: 'removeCustomFieldValue',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove/clear a custom field value from a ClickUp task. Clears the VALUE only — the field itself, and '
    + 'any drop-down or label options on it, are untouched and cannot be deleted through ClickUp\'s API.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    fieldId: z.string().describe('The custom field ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.removeCustomFieldValue(args.taskId, args.fieldId);
    return `Custom field ${args.fieldId} removed from task ${args.taskId}.`;
  },
});

// === Tags ===

clickUpServer.addTool({
  name: 'listSpaceTags',
  annotations: { readOnlyHint: true },
  description: 'List all tags defined in a ClickUp space. Use this to discover tag names available for addTagToTask / removeTagFromTask.',
  parameters: z.object({
    spaceId: z.string().describe('The space ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getSpaceTags(args.spaceId);
    const tags = result.tags || [];
    if (tags.length === 0) return 'No tags found in this space.';
    return tags.map((t: any) => {
      const parts = [`Tag: ${t.name}`];
      if (t.tag_fg) parts.push(`  Foreground: ${t.tag_fg}`);
      if (t.tag_bg) parts.push(`  Background: ${t.tag_bg}`);
      return parts.join('\n');
    }).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'addTagToTask',
  annotations: { readOnlyHint: false },
  description: 'Add a tag to a ClickUp task. If the tag does not already exist in the task\'s space, ClickUp auto-creates it on the fly — call listSpaceTags first when you want to reuse existing tags and avoid tag proliferation. ClickUp\'s updateTask endpoint does not accept tags; this is the correct way to tag an existing task.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    tagName: z.string().min(1).describe('The tag name. ClickUp will auto-create it in the task\'s space if it does not already exist.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.addTagToTask(args.taskId, args.tagName);
    return `Tag "${args.tagName}" added to task ${args.taskId}.`;
  },
});

clickUpServer.addTool({
  name: 'removeTagFromTask',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a tag from a ClickUp task. Does not delete the tag from the space — only unassigns it from this task.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    tagName: z.string().min(1).describe('The tag name to remove from the task.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.removeTagFromTask(args.taskId, args.tagName);
    return `Tag "${args.tagName}" removed from task ${args.taskId}.`;
  },
});

clickUpServer.addTool({
  name: 'getTaskMembers',
  annotations: { readOnlyHint: true },
  description: 'List all members assigned to a ClickUp task.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getTaskMembers(args.taskId);
    const members = result.members || [];
    if (members.length === 0) return 'No members assigned to this task.';
    return members.map((m: any) =>
      `${m.username || m.email} (ID: ${m.id})`
    ).join('\n');
  },
});

// === Tier 3.5: Task event webhooks (PR1 — subscribe only; query tool in PR2) ===

clickUpServer.addTool({
  name: 'subscribeToTaskEvents',
  annotations: { readOnlyHint: false },
  description: 'Subscribe this user\'s digest routine to ClickUp task events for a workspace. Creates a webhook on ClickUp\'s side and stores its shared secret so the ingestion endpoint can verify inbound POSTs. IDEMPOTENT: re-calling with the same (user, workspace) returns the existing subscription without hitting ClickUp again. Default event bundle is `taskCreated`, `taskStatusUpdated`, `taskAssigneeUpdated`, `taskMoved`, `taskDeleted` — deliberately excludes `taskUpdated` (firehose, redundant with the pull-side `date_updated_gt` filter on filterTeamTasks). Requires the BASE_URL env var so ClickUp can call back. Once subscribed, the event store accrues from this moment forward — history queries against events before this timestamp fall back to the `date_updated + current status` approximation.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID to subscribe to.'),
    events: z.array(z.enum([
      'taskCreated',
      'taskStatusUpdated',
      'taskAssigneeUpdated',
      'taskMoved',
      'taskDeleted',
    ])).optional().describe('Event types to subscribe to. Defaults to all five in the recommended bundle.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('subscribeToTaskEvents requires a logged-in user context.');
    }
    const client = getClickUpClient(session);
    const events = (args.events && args.events.length > 0) ? args.events : [...CAPTURED_EVENTS];
    const store = await import('./taskEventStore.js');

    const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new UserError('BASE_URL env var must be set to create webhooks (ClickUp needs a callback URL).');
    }
    const endpoint = `${baseUrl}/webhooks/clickup/inbound`;

    let result;
    try {
      result = await subscribeToTaskEventsFlow(
        {
          createWebhook: (ws, p) => client.createWebhook(ws, p),
          deleteWebhook: (id) => client.deleteWebhook(id),
          findSubscription: store.findSubscription,
          createSubscription: store.createSubscription,
        },
        { userId: session.userId, workspaceId: args.workspaceId, events, endpoint },
      );
    } catch (err: any) {
      throw new UserError(err?.message || String(err));
    }

    const sub = result.subscription;
    if (result.kind === 'existing') {
      return [
        'Subscription already active (idempotent no-op).',
        `  Subscription ID: ${sub.id}`,
        `  ClickUp webhook ID: ${sub.clickupWebhookId}`,
        `  Events: ${sub.events.join(', ')}`,
        `  Status: ${sub.status} (fail_count: ${sub.failCount})`,
        `  Created: ${sub.createdAt}`,
      ].join('\n');
    }
    return [
      'Subscription created.',
      `  Subscription ID: ${sub.id}`,
      `  ClickUp webhook ID: ${sub.clickupWebhookId}`,
      `  Events: ${sub.events.join(', ')}`,
      `  Callback URL: ${endpoint}`,
      `  History accrues from: ${sub.createdAt}`,
    ].join('\n');
  },
});

clickUpServer.addTool({
  name: 'getTaskEventHistory',
  annotations: { readOnlyHint: true },
  description: 'Read from-status→to-status transitions (and other captured events) for a ClickUp workspace, sourced from the event store populated by subscribeToTaskEvents. Use this to answer "what moved to In Review since last report" exactly, instead of approximating from date_updated + current status. IMPORTANT: history accrues from the moment subscribeToTaskEvents was first called — events before that boundary are NOT in the store; the response includes `eventStoreStartedAt` so the caller can fall back to filterTeamTasks with dateUpdatedGt for any earlier window. If no subscription exists for the (user, workspace), the response is `kind: "no-subscription"` with a warning — not an error — so the digest can gracefully fall back to pull.'
    + ' Parent changes are NOT captured: ClickUp emits no webhook event when a task\'s parent changes (taskMoved is a '
    + 'LIST move, not a re-parent), so an empty result here never means "nothing was re-parented" — a re-parent done '
    + 'through updateTask is recorded only in that call\'s own response.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    since: z.string().optional().describe('Only return events at/after this time. ISO string or Unix ms.'),
    until: z.string().optional().describe('Only return events at/before this time. ISO string or Unix ms.'),
    eventTypes: z.array(z.enum([
      'taskCreated',
      'taskStatusUpdated',
      'taskAssigneeUpdated',
      'taskMoved',
      'taskDeleted',
    ])).optional().describe('Filter to specific event types. Omit for all captured events.'),
    toStatus: z.string().optional().describe('Only return status-transition events whose destination status equals this label. Combine with eventTypes=["taskStatusUpdated"] for "moved to X since T".'),
    taskId: z.string().optional().describe('Narrow to a single task.'),
    limit: z.number().int().min(1).max(2000).optional().describe('Row cap (default 500, max 2000). Narrow via `since` if you hit the cap.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('getTaskEventHistory requires a logged-in user context.');
    }
    const parseTs = (input: string | undefined, field: string): number | undefined => {
      if (!input) return undefined;
      const ts = parseTimestampInput(input);
      if (Number.isNaN(ts)) throw new UserError(`Invalid ${field}: ${input}`);
      return ts;
    };
    const since = parseTs(args.since, 'since');
    const until = parseTs(args.until, 'until');
    const store = await import('./taskEventStore.js');

    const result = await queryTaskEventsFlow(
      {
        findSubscription: store.findSubscription,
        queryTaskEvents: store.queryTaskEvents,
      },
      {
        userId: session.userId,
        workspaceId: args.workspaceId,
        since, until,
        eventTypes: args.eventTypes,
        toStatus: args.toStatus,
        taskId: args.taskId,
        limit: args.limit,
      },
    );

    if (result.kind === 'no-subscription') {
      return [
        'No task-event subscription for this workspace.',
        `  Warning: ${result.warning}`,
      ].join('\n');
    }

    const header = [
      `Found ${result.events.length} event(s) in workspace ${args.workspaceId}.`,
      `  Event store started: ${result.eventStoreStartedAt}`,
      `  Subscription: ${result.subscription!.id} (fail_count: ${result.subscription!.failCount})`,
    ];
    if (result.warning) header.push(`  Warning: ${result.warning}`);
    if (result.events.length === 0) return header.join('\n');

    const rows = result.events.map(e => {
      const when = new Date(e.occurredAt).toISOString();
      const actor = e.actorUsername || e.actorId || 'unknown';
      const transition = e.field
        ? `${e.field}: ${e.fromVal ?? '?'} → ${e.toVal ?? '?'}`
        : '(no field diff)';
      return `- ${when}  task=${e.taskId}  ${e.eventType}  ${transition}  by ${actor}`;
    });
    return [...header, '', ...rows].join('\n');
  },
});

clickUpServer.addTool({
  name: 'listTaskEventSubscriptions',
  annotations: { readOnlyHint: true },
  description: 'List task-event webhook subscriptions owned by the current user. Surfaces fail_count so operators can spot a dying webhook (ClickUp stops delivering after 5 consecutive failures). Optionally narrow to a single workspace.',
  parameters: z.object({
    workspaceId: z.string().optional().describe('Optional workspace ID to narrow to a single subscription.'),
  }),
  execute: async (_args, { session }) => {
    if (!session?.userId) {
      throw new UserError('listTaskEventSubscriptions requires a logged-in user context.');
    }
    const store = await import('./taskEventStore.js');
    const subs = await store.listSubscriptionsForUser(session.userId, _args.workspaceId);
    if (subs.length === 0) return 'No task-event subscriptions.';
    return subs.map(s => [
      `Subscription ${s.id}`,
      `  Workspace: ${s.workspaceId}`,
      `  ClickUp webhook: ${s.clickupWebhookId}`,
      `  Events: ${s.events.join(', ')}`,
      `  Status: ${s.status} (fail_count: ${s.failCount})`,
      `  Created: ${s.createdAt}`,
    ].join('\n')).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'debugTaskEventSubscription',
  annotations: { readOnlyHint: true },
  description: 'Cross-reference the local task-event subscription against ClickUp\'s own view of the webhook and the event store, and surface anomalies. Use when subscribeToTaskEvents reports success but events aren\'t landing, or when local fail_count doesn\'t match reality. Detects: endpoint-URL drift (BASE_URL changed since subscribe), orphaned ClickUp webhook (local record points at a webhook ClickUp deleted), event-bundle mismatch, ClickUp fail_count > local fail_count (ClickUp seeing non-2xx/timeouts while our counter stays flat — NOT the silent-200 pattern), disabled webhook status, and the "zero events with zero failures" pattern (silent 200s: ingestion returning success without persisting).',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('debugTaskEventSubscription requires a logged-in user context.');
    }
    const client = getClickUpClient(session);
    const store = await import('./taskEventStore.js');
    const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
    const expectedEndpoint = baseUrl ? `${baseUrl}/webhooks/clickup/inbound` : '';

    const report = await debugTaskEventSubscriptionFlow(
      {
        findSubscription: store.findSubscription,
        listWebhooks: (workspaceId) => client.listWebhooks(workspaceId),
        countTaskEventsForSubscription: store.countTaskEventsForSubscription,
        queryTaskEvents: store.queryTaskEvents,
      },
      { userId: session.userId, workspaceId: args.workspaceId, expectedEndpoint },
    );

    const lines: string[] = [
      `Task-Event Subscription Diagnostic — workspace ${report.workspaceId}`,
      `  Expected endpoint (from current BASE_URL): ${report.expectedEndpoint || '(BASE_URL not set)'}`,
      `  Overall: ${report.kind}`,
      '',
    ];
    if (report.local) {
      lines.push(
        'Local subscription record:',
        `  Subscription ID: ${report.local.id}`,
        `  ClickUp webhook ID: ${report.local.clickupWebhookId}`,
        `  Events: [${report.local.events.join(', ')}]`,
        `  Status: ${report.local.status}, fail_count: ${report.local.failCount}`,
        `  Created: ${report.local.createdAt}`,
        '',
      );
    } else {
      lines.push('Local subscription record: (none)', '');
    }
    if (report.clickup) {
      lines.push(
        'ClickUp\'s view:',
        `  Webhook ID: ${report.clickup.id}`,
        `  Endpoint: ${report.clickup.endpoint}`,
        `  Events: [${report.clickup.events.join(', ')}]`,
        `  health.status: ${report.clickup.healthStatus ?? '(unknown)'}`,
        `  health.fail_count: ${report.clickup.healthFailCount ?? '(unknown)'}`,
        '',
      );
    } else {
      lines.push('ClickUp\'s view: (no matching webhook found in this workspace)', '');
    }
    if (report.eventStore) {
      lines.push(
        'Event store:',
        `  Total events for this subscription: ${report.eventStore.count}`,
        `  Most recent occurredAt: ${report.eventStore.mostRecentOccurredAt !== null ? new Date(report.eventStore.mostRecentOccurredAt).toISOString() : '(none)'}`,
        `  Most recent receivedAt: ${report.eventStore.mostRecentReceivedAt ?? '(none)'}`,
        '',
      );
    }
    lines.push('Findings:');
    for (const f of report.findings) lines.push(`  - ${f}`);
    return lines.join('\n');
  },
});

clickUpServer.addTool({
  name: 'unsubscribeFromTaskEvents',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete the ClickUp task-event subscription for a workspace. Best-effort deletes both the ClickUp-side webhook and the local record; if ClickUp already deleted or disabled the webhook, still clears the local row so a fresh subscribeToTaskEvents can create a new one. Use this to recover from the "webhook disabled by ClickUp after 5 fails" state or after debugTaskEventSubscription flags an endpoint mismatch.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID to unsubscribe from.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('unsubscribeFromTaskEvents requires a logged-in user context.');
    }
    const client = getClickUpClient(session);
    const store = await import('./taskEventStore.js');

    const sub = await store.findSubscription(session.userId, args.workspaceId);
    if (!sub) {
      return `No task-event subscription found for workspace ${args.workspaceId}. Nothing to unsubscribe.`;
    }

    // Try ClickUp first. If ClickUp already deleted/disabled the webhook,
    // this may 404 or 5xx — we still want to clear the local row so a
    // subsequent subscribe isn't blocked by the idempotency short-circuit.
    let clickupNote = 'deleted';
    try {
      await client.deleteWebhook(sub.clickupWebhookId);
    } catch (err: any) {
      clickupNote = `delete failed (${err?.message || err}) — may be orphaned on ClickUp's side`;
    }

    const deleted = await store.deleteSubscription(session.userId, args.workspaceId);
    return [
      'Unsubscribed.',
      `  Local record: ${deleted ? 'deleted' : 'not found (unexpected — findSubscription had returned a row)'}`,
      `  ClickUp webhook (${sub.clickupWebhookId}): ${clickupNote}`,
      '',
      `Call subscribeToTaskEvents again to start a fresh subscription with a new shared_secret.`,
    ].join('\n');
  },
});

// === Tier 4: Space/List Management ===

clickUpServer.addTool({
  name: 'createList',
  annotations: { readOnlyHint: false },
  description: 'Create a new list in a ClickUp folder, or a folderless list in a space.',
  parameters: z.object({
    folderId: z.string().optional().describe('The folder ID (for a list inside a folder).'),
    spaceId: z.string().optional().describe('The space ID (for a folderless list). Used when folderId is not provided.'),
    name: z.string().min(1).describe('Name for the new list.'),
    content: z.string().optional().describe('Description/content for the list (plain text). Use markdownContent instead for formatted text.'),
    markdownContent: z.string().optional().describe('Description/content in markdown format. Takes precedence over content.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    if (!args.folderId && !args.spaceId) {
      throw new UserError('Provide either folderId or spaceId.');
    }
    const data: any = {
      name: args.name,
      ...(args.markdownContent ? { markdown_content: args.markdownContent } : { content: args.content }),
    };
    const list = args.folderId
      ? await client.createList(args.folderId, data)
      : await client.createFolderlessList(args.spaceId!, data);
    return `List created:\n  Name: ${list.name}\n  ID: ${list.id}`;
  },
});

clickUpServer.addTool({
  name: 'createFolder',
  annotations: { readOnlyHint: false },
  description: 'Create a new folder in a ClickUp space.',
  parameters: z.object({
    spaceId: z.string().describe('The space ID to create the folder in.'),
    name: z.string().min(1).describe('Name for the new folder.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const folder = await client.createFolder(args.spaceId, { name: args.name });
    return `Folder created:\n  Name: ${folder.name}\n  ID: ${folder.id}`;
  },
});

clickUpServer.addTool({
  name: 'createSpace',
  annotations: { readOnlyHint: false },
  description: 'Create a new space in a ClickUp workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    name: z.string().min(1).describe('Name for the new space.'),
    multipleAssignees: z.boolean().optional().default(true).describe('Allow multiple assignees on tasks.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const space = await client.createSpace(args.workspaceId, {
      name: args.name,
      multiple_assignees: args.multipleAssignees,
    });
    return `Space created:\n  Name: ${space.name}\n  ID: ${space.id}`;
  },
});

clickUpServer.addTool({
  name: 'updateList',
  annotations: { readOnlyHint: false },
  description: 'Update properties of an existing ClickUp list.',
  parameters: z.object({
    listId: z.string().describe('The list ID to update.'),
    ...listUpdateFields,
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const data: any = {};
    if (args.name !== undefined) data.name = args.name;
    if (args.content !== undefined) data.content = args.content;
    if (args.dueDate !== undefined) data.due_date = new Date(args.dueDate).getTime();
    if (args.priority !== undefined) data.priority = args.priority;
    const list = await client.updateList(args.listId, data);
    return `List updated:\n  Name: ${list.name}\n  ID: ${list.id}`;
  },
});

clickUpServer.addTool({
  name: 'deleteList',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a ClickUp list permanently.',
  parameters: z.object({
    listId: z.string().describe('The list ID to delete.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.deleteList(args.listId);
    return `List ${args.listId} deleted successfully.`;
  },
});

// === Tier 5: Documents & Time ===

clickUpServer.addTool({
  name: 'listDocs',
  annotations: { readOnlyHint: true },
  description: 'List one page of ClickUp Docs in a workspace, in ClickUp\'s own order (oldest first). Returns a cursor when more pages exist. To find a doc by name, or to get every doc newest-first, use searchDocs instead — it pages through the whole workspace for you.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    limit: z.number().optional().default(100).describe('Docs per page (10-100, default 100).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.listDocs(args.workspaceId, { limit: args.limit, cursor: args.cursor });
    const docs = docsFromEnvelope(result);
    if (docs.length === 0) return 'No docs found in this workspace.';
    let output = docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}\n  Created: ${d.date_created ? new Date(parseInt(d.date_created)).toISOString() : 'unknown'}`
    ).join('\n\n');
    const nextCursor = cursorFromEnvelope(result);
    if (nextCursor) output += `\n\n---\nMore docs available. Use cursor: "${nextCursor}"`;
    return output;
  },
});

clickUpServer.addTool({
  name: 'getDoc',
  annotations: { readOnlyHint: true },
  description: 'Get a ClickUp Doc by ID, including its pages and their content (markdown).',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    docId: z.string().describe('The doc ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);

    // Get doc metadata
    const doc = await client.getDoc(args.workspaceId, args.docId);
    const parts = [
      `Doc: ${doc.name || doc.title || 'Untitled'}`,
      `  ID: ${doc.id}`,
    ];
    if (doc.date_created) parts.push(`  Created: ${new Date(parseInt(doc.date_created)).toISOString()}`);
    if (doc.date_updated) parts.push(`  Updated: ${new Date(parseInt(doc.date_updated)).toISOString()}`);

    // Fetch pages and their content
    try {
      const pagesResult = await client.getDocPages(args.workspaceId, args.docId);
      const pages = pagesResult.pages || pagesResult.data || pagesResult || [];
      if (Array.isArray(pages) && pages.length > 0) {
        parts.push('\nPages:');
        for (const page of pages) {
          const pageId = page.id;
          const pageName = page.name || page.title || 'Untitled Page';
          parts.push(`\n--- ${pageName} (ID: ${pageId}) ---`);
          // Fetch full page content individually
          try {
            const fullPage = await client.getPage(args.workspaceId, args.docId, pageId);
            if (fullPage.content) parts.push(fullPage.content);
            else parts.push('(empty)');
          } catch {
            if (page.content) parts.push(page.content);
            else parts.push('(content unavailable)');
          }
        }
      }
    } catch { /* pages endpoint may not exist for all docs */ }

    return parts.join('\n');
  },
});

clickUpServer.addTool({
  name: 'searchDocs',
  annotations: { readOnlyHint: true },
  description: 'Find ClickUp Docs by name, newest first. Pages through the entire workspace, so a recently-created doc is found regardless of how many docs exist. Matching is case-insensitive and token-based: every word in the query must appear in the title, in any order, so "AWESOME Sync" matches "[AWESOME] Sync - 08/15/2026". Omit query to list every doc newest-first. Always reports how many docs were scanned, so an empty result means "not there" rather than "did not look".',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    query: z.string().optional().describe('Words to match against doc names (case-insensitive, order-independent, all words must appear). Omit to list all docs.'),
    creator: z.number().optional().describe('Filter by creator user ID.'),
    parentId: z.string().optional().describe('Filter by parent ID (Space, Folder, or List). Required when parentType is SPACE, FOLDER, or LIST.'),
    parentType: z.enum(['SPACE', 'FOLDER', 'LIST', 'EVERYTHING', 'WORKSPACE']).optional().describe('Restrict to docs living in this kind of container. EVERYTHING means no restriction (the default behaviour). SPACE/FOLDER/LIST require parentId.'),
  }).refine(
    (a) => !(a.parentType && ['SPACE', 'FOLDER', 'LIST'].includes(a.parentType)) || !!a.parentId,
    { message: 'parentType SPACE, FOLDER, or LIST requires parentId.', path: ['parentId'] },
  ),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const scan = await client.searchAllDocs(args.workspaceId, {
      query: args.query,
      creator: args.creator,
      parentId: args.parentId,
      parentType: args.parentType,
    });

    // The scan extent goes on every response, hit or miss. The bug this fixes
    // was not "search missed a doc" so much as "search said the doc did not
    // exist", so a bare no-match line is never acceptable here.
    const scope = `Scanned ${scan.totalScanned} doc(s) across ${scan.pagesScanned} page(s).`;
    const warnings: string[] = [];
    if (scan.hitCap) warnings.push(`⚠ Stopped at the ${DOCS_MAX_PAGES}-page scan cap — results may be incomplete. Narrow with parentId/creator, or page manually with listDocs.`);
    if (scan.rateLimited) warnings.push('⚠ ClickUp rate-limited the scan partway through — results may be incomplete. Retry in a moment.');

    if (scan.docs.length === 0) {
      const head = args.query
        ? `No docs found matching "${args.query}".`
        : 'No docs found in this workspace.';
      return [head, scope, ...warnings].join('\n');
    }

    const body = scan.docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}${d.date_created ? `\n  Created: ${new Date(parseInt(d.date_created)).toISOString()}` : ''}`
    ).join('\n\n');
    return [body, '---', scope, ...warnings].join('\n');
  },
});

clickUpServer.addTool({
  name: 'createDoc',
  annotations: { readOnlyHint: false },
  description: 'Create a new ClickUp Doc in a workspace. Optionally place it inside a Space, Folder, or List by providing parent ID and type.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    ...createDocFields,
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const data: any = { name: args.name };
    // Note: ClickUp's createDoc API ignores the content field — content must
    // be written to the auto-created page separately via editPage.
    if (args.parentId && args.parentType !== undefined) {
      data.parent = { id: args.parentId, type: args.parentType };
    }
    const result = await client.createDoc(args.workspaceId, data);
    const docId = result.id;

    // If content was provided, write it to the auto-created first page
    if (args.content) {
      try {
        const pagesResult = await client.getDocPages(args.workspaceId, docId);
        const pages = pagesResult.pages || pagesResult.data || pagesResult || [];
        if (Array.isArray(pages) && pages.length > 0) {
          await client.editPage(args.workspaceId, docId, pages[0].id, {
            content: args.content,
            content_format: 'text/md',
            content_edit_mode: 'replace',
          });
        } else {
          // No auto-created page — create one with content
          await client.createPage(args.workspaceId, docId, {
            name: args.name,
            content: args.content,
            content_format: 'text/md',
          });
        }
      } catch {
        // Content write failed but doc was created — report partial success
        return `Doc created: ${result.name || result.title || args.name}\n  ID: ${docId}\n  ⚠ Content could not be written to the page. Use editPage to add content manually.`;
      }
    }

    return `Doc created: ${result.name || result.title || args.name}\n  ID: ${docId}`;
  },
});

clickUpServer.addTool({
  name: 'getPage',
  annotations: { readOnlyHint: true },
  description: 'Get a specific page from a ClickUp Doc, including its full content in markdown.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    docId: z.string().describe('The doc ID.'),
    pageId: z.string().describe('The page ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const page = await client.getPage(args.workspaceId, args.docId, args.pageId);
    const parts = [
      `Page: ${page.name || page.title || 'Untitled'}`,
      `  ID: ${page.id}`,
    ];
    if (page.sub_title) parts.push(`  Subtitle: ${page.sub_title}`);
    if (page.content) parts.push(`\n${page.content}`);
    else parts.push('\n(empty)');
    return parts.join('\n');
  },
});

clickUpServer.addTool({
  name: 'createPage',
  annotations: { readOnlyHint: false },
  description: 'Create a new page in a ClickUp Doc.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    docId: z.string().describe('The doc ID.'),
    ...createPageFields,
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const data: any = {};
    if (args.name) data.name = args.name;
    if (args.content) { data.content = args.content; data.content_format = 'text/md'; }
    if (args.parentPageId) data.parent_page_id = args.parentPageId;
    const result = await client.createPage(args.workspaceId, args.docId, data);
    return `Page created: ${result.name || args.name || 'Untitled'}\n  ID: ${result.id}\n  Doc: ${args.docId}`;
  },
});

clickUpServer.addTool({
  name: 'editPage',
  annotations: { readOnlyHint: false },
  description: 'Edit a page in a ClickUp Doc. Can replace, append, or prepend content.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    docId: z.string().describe('The doc ID.'),
    pageId: z.string().describe('The page ID.'),
    ...editPageFields,
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const data: any = {};
    if (args.name) data.name = args.name;
    if (args.content) {
      data.content = args.content;
      data.content_format = 'text/md';
      data.content_edit_mode = args.editMode || 'replace';
    }
    await client.editPage(args.workspaceId, args.docId, args.pageId, data);
    return `Page ${args.pageId} updated (${args.editMode || 'replace'}).`;
  },
});

clickUpServer.addTool({
  name: 'insertImageIntoPage',
  annotations: { readOnlyHint: false },
  description: 'Add an image to a ClickUp Doc page. Provide the image as EXACTLY ONE of imageUrl (a public http(s) URL — strongly preferred) or imageBase64 (base64 bytes, for SMALL images only — the payload consumes the calling model context, so use imageUrl whenever a public URL exists). The image is re-hosted (recompressed to WebP) and embedded as markdown (append by default). ClickUp has no image-upload API for docs, so the image is stored and served by this server — requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL. If imageUrl is already on this server, re-hosting is skipped automatically; pass skipRehost:true to force embedding the given URL as-is.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    docId: z.string().describe('The doc ID.'),
    pageId: z.string().describe('The page ID to add the image to.'),
    ...insertImageFields,
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    // Fail fast if the image host isn't configured (also the base for the
    // already-hosted check below). Only the storage module reads the env.
    const publicBase = getImagePublicBaseUrl();
    assertOneImageSource(args);

    // Skip the fetch-and-store round trip when the image is already served by
    // our own image host (never needs re-hosting), or when the caller explicitly
    // opts out (imageUrl only). The host check is origin+path strict. Otherwise
    // both URL and base64 sources converge on the single store path.
    const url = (args.imageUrl && (args.skipRehost || isImageUrlOnOurHost(args.imageUrl, publicBase)))
      ? args.imageUrl
      : await storeImageFromArgs(args);

    const editMode = args.editMode || 'append';
    // No orphan cleanup on failure: image_blobs is content-addressed and deduped,
    // so a blob may be shared by other docs — deleting it here could break them.
    // A leftover, unreferenced blob is harmless (immutable, reclaimable by GC).
    await client.editPage(args.workspaceId, args.docId, args.pageId, {
      content: `![${args.altText || ''}](${url})`,
      content_format: 'text/md',
      content_edit_mode: editMode,
    });
    return `Image added to page ${args.pageId} (${editMode}).\nHosted at: ${url}`;
  },
});

clickUpServer.addTool({
  name: 'uploadClickUpDocImage',
  annotations: { readOnlyHint: false },
  description: 'Re-host an image on this server (recompressed to WebP) and return a public URL you can embed in a ClickUp Doc page as markdown (![](url)). Provide the image as EXACTLY ONE of imageUrl (a public http(s) URL — strongly preferred) or imageBase64 (base64 bytes, for SMALL images only — the payload consumes the calling model context, so use imageUrl whenever a public URL exists). Use this when you want the URL without immediately writing to a page; otherwise use insertImageIntoPage. Requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL to be configured.',
  parameters: z.object({
    imageUrl: z.string().optional().describe('Public http(s) URL of the image to re-host (jpg, png, gif, bmp, or webp; max 20 MB). Provide exactly one of imageUrl or imageBase64; prefer imageUrl when a public URL exists.'),
    imageBase64: z.string().optional().describe('Base64-encoded image bytes (a data:...;base64, prefix is accepted and stripped). For SMALL images only — ~100KB ideal, hard limit ~1.5 MB decoded — because the payload consumes the calling model context. Provide exactly one of imageUrl or imageBase64.'),
    fileName: z.string().optional().describe('Optional filename, used only for error messages/logging. NOT used to determine the image format (magic bytes decide).'),
  }),
  execute: async (args) => {
    // Fail fast if the image host isn't configured, before spending a fetch/decode.
    getImagePublicBaseUrl();
    assertOneImageSource(args);
    const url = await storeImageFromArgs(args);
    return `Image re-hosted. Public URL:\n${url}\n\nEmbed it in a page with markdown: ![](${url})`;
  },
});

clickUpServer.addTool({
  name: 'listWorkspaceMembers',
  annotations: { readOnlyHint: true },
  description: 'List all members of a ClickUp workspace. Useful for looking up user IDs by name when assigning tasks.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getWorkspaces();
    const team = (result.teams || []).find((t: any) => String(t.id) === String(args.workspaceId));
    if (!team) return `Workspace ${args.workspaceId} not found.`;
    const members = team.members || [];
    if (members.length === 0) return 'No members found in this workspace.';
    return members.map((m: any) => {
      const u = m.user || m;
      return `${u.username || u.email}\n  ID: ${u.id}\n  Email: ${u.email || 'N/A'}\n  Role: ${m.role || 'member'}`;
    }).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'startTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Start a time tracking entry for a task in ClickUp.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    taskId: z.string().describe('The task ID to track time for.'),
    description: z.string().optional().describe('Description for the time entry.'),
    billable: z.boolean().optional().default(false).describe('Whether this time entry is billable.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.startTimeEntry(args.workspaceId, {
      tid: args.taskId,
      description: args.description,
      billable: args.billable,
    });
    return `Time tracking started for task ${args.taskId}. Entry ID: ${result.data?.id || 'started'}`;
  },
});

clickUpServer.addTool({
  name: 'stopTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Stop the currently running time tracking entry.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.stopTimeEntry(args.workspaceId);
    return `Time tracking stopped. ${result.data?.id ? 'Entry ID: ' + result.data.id : ''}`;
  },
});

clickUpServer.addTool({
  name: 'getTimeEntries',
  annotations: { readOnlyHint: true },
  description: 'Get time tracking entries for a workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    startDate: z.string().optional().describe('Start date as ISO string (filters entries after this date).'),
    endDate: z.string().optional().describe('End date as ISO string (filters entries before this date).'),
    assignee: z.string().optional().describe('Filter by user ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getTimeEntries(args.workspaceId, {
      start_date: args.startDate ? new Date(args.startDate).getTime() : undefined,
      end_date: args.endDate ? new Date(args.endDate).getTime() : undefined,
      assignee: args.assignee,
    });
    const entries = result.data || [];
    if (entries.length === 0) return 'No time entries found.';
    return entries.map((e: any) => {
      const duration = e.duration ? `${Math.round(parseInt(e.duration) / 60000)} min` : 'running';
      return `Time Entry: ${e.description || 'No description'}\n  ID: ${e.id}\n  Duration: ${duration}\n  Task: ${e.task?.name || e.task_id || 'unknown'}\n  User: ${e.user?.username || 'unknown'}`;
    }).join('\n\n');
  },
});
