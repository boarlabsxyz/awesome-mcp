// src/clickup/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  ClickUpClient,
  collectTasksInCloseWindow,
  formatCloseWindowCapMessage,
  markdownToCommentBlocks,
  parseCloseWindow,
  parseTimestampInput,
} from './apiHelpers.js';
import { formatTask, formatTaskList } from './formatHelpers.js';
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
  description: 'Get detailed information about a specific ClickUp task by its ID.',
  parameters: z.object({
    taskId: z.string().describe('The task ID (e.g., "abc123" or custom task ID).'),
    includeSubtasks: z.boolean().optional().default(false).describe('Include subtasks in response.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const task = await client.getTask(args.taskId, args.includeSubtasks);
    let output = formatTask(task);
    if (args.includeSubtasks && task.subtasks?.length) {
      output += '\n\n  Subtasks:\n' + task.subtasks.map((st: any) =>
        `    - ${st.name} (${st.id}) [${st.status?.status || 'unknown'}]`
      ).join('\n');
    }
    return output;
  },
});

clickUpServer.addTool({
  name: 'listTasks',
  annotations: { readOnlyHint: true },
  description: 'List tasks in a ClickUp list with optional filters. To query tasks closed within a window, set closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and filters locally on date_closed (ClickUp\'s REST API has no server-side close-date filter).',
  parameters: z.object({
    listId: z.string().describe('The list ID to get tasks from.'),
    archived: z.boolean().optional().default(false).describe('Include archived tasks.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based). Each page returns up to 100 tasks. Ignored when closedAfter/closedBefore is set.'),
    orderBy: z.enum(['id', 'created', 'updated', 'due_date']).optional().describe('Field to order by.'),
    reverse: z.boolean().optional().default(false).describe('Reverse the order.'),
    subtasks: z.boolean().optional().default(false).describe('Include subtasks.'),
    statuses: z.array(z.string()).optional().describe('Filter by status names.'),
    includeClosed: z.boolean().optional().default(false).describe('Include closed tasks. Automatically forced true when closedAfter/closedBefore is set.'),
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
            assignees: args.assignees,
          });
          return res.tasks || [];
        },
        win.from,
        win.to,
      );
      if (hitCap) throw new UserError(formatCloseWindowCapMessage(pagesScanned));
      return formatTaskList(tasks);
    }

    const result = await client.getTasks(args.listId, {
      archived: args.archived,
      page: args.page,
      order_by: args.orderBy,
      reverse: args.reverse,
      subtasks: args.subtasks,
      statuses: args.statuses,
      include_closed: args.includeClosed,
      assignees: args.assignees,
    });
    return formatTaskList(result.tasks || []);
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
    });
    return `Task created successfully:\n${formatTask(task)}`;
  },
});

clickUpServer.addTool({
  name: 'updateTask',
  annotations: { readOnlyHint: false },
  description: 'Update an existing ClickUp task. Only provided fields will be changed.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to update.'),
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
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
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

    const task = await client.updateTask(args.taskId, data);
    return `Task updated successfully:\n${formatTask(task)}`;
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
  description: 'Move a task to a different list.',
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
      return `Comment by ${author} (${date}):\n  ${text.substring(0, 300)}`;
    }).join('\n\n');
  },
});

// === Tier 3: Search ===

clickUpServer.addTool({
  name: 'filterTeamTasks',
  annotations: { readOnlyHint: true },
  description: 'Query tasks across a ClickUp workspace using ClickUp\'s server-side "Get Filtered Team Tasks" endpoint (GET /api/v2/team/{team_id}/task). One paginated call replaces per-list enumeration for workspace-wide digests. Returns tasks the caller can access (naturally scoped by the OAuth identity), 100 per page — iterate `page` from 0 to fetch all. Supports assignees, statuses, tags, scope narrowing (spaceIds/projectIds/listIds), and date ranges on date_created / date_updated / due_date. IMPORTANT: ClickUp does NOT support date_closed / date_done filters or a close-date sort here — for "closed since T", query with `dateUpdatedGt=T` (closing bumps date_updated, so this is a superset) and partition on each task\'s `date_closed` client-side.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    assignees: z.array(z.string()).optional().describe('Filter to tasks assigned to any of these user IDs.'),
    statuses: z.array(z.string()).optional().describe('Filter to tasks in any of these status names.'),
    tags: z.array(z.string()).optional().describe('Filter to tasks with any of these tag names.'),
    spaceIds: z.array(z.string()).optional().describe('Narrow to tasks in these space IDs.'),
    projectIds: z.array(z.string()).optional().describe('Narrow to tasks in these folder (project) IDs.'),
    listIds: z.array(z.string()).optional().describe('Narrow to tasks in these list IDs.'),
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
    return `Found ${tasks.length} task(s):\n\n` + tasks.map(formatTask).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'searchTasks',
  annotations: { readOnlyHint: true },
  description: 'Search for tasks across a ClickUp workspace. Supports filtering by name (client-side substring match) and/or custom fields. By default excludes closed/completed tasks — set includeClosed=true to include them. To query tasks closed within a window, set closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and filters locally on date_closed (ClickUp\'s REST API has no server-side close-date filter).',
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
      return `Found ${filtered.length} task(s) closed in window:\n\n` + filtered.map(formatTask).join('\n\n');
    }

    const result = await client.searchTasks(args.workspaceId, args.query, args.page, args.custom_fields, args.includeClosed);
    const tasks = result.tasks || [];
    if (tasks.length === 0) return `No tasks found${args.query ? ` matching "${args.query}"` : ''}.`;
    return `Found ${tasks.length} task(s):\n\n` + tasks.map(formatTask).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'getAccessibleCustomFields',
  annotations: { readOnlyHint: true },
  description: 'List all custom fields available on a ClickUp list. Use this to discover field IDs for filtering or setting values.',
  parameters: z.object({
    listId: z.string().describe('The list ID to get custom fields for.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getAccessibleCustomFields(args.listId);
    const fields = result.fields || [];
    if (fields.length === 0) return 'No custom fields found on this list.';
    return `Found ${fields.length} custom field(s):\n\n` + fields.map((f: any) => {
      const parts = [`Field: ${f.name}`, `  ID: ${f.id}`, `  Type: ${f.type}`];
      if (f.type_config?.options) {
        parts.push('  Options:');
        f.type_config.options.forEach((o: any) => {
          parts.push(`    - ${o.name || o.label} (id: ${o.id}, orderindex: ${o.orderindex}${o.color ? `, color: ${o.color}` : ''})`);
        });
        parts.push('  Note: For searchTasks custom_fields filter with ANY/ALL operators, use the option "id" (UUID), not orderindex or label.');
      }
      return parts.join('\n');
    }).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'setCustomFieldValue',
  annotations: { readOnlyHint: false },
  description: 'Set a custom field value on a ClickUp task. Use getAccessibleCustomFields first to find the field ID and type. Value shape depends on field type: text/email/phone → string; number → number; drop_down → option orderindex (int); users → array of user IDs; labels → array of label UUIDs; date → unix ms. NOTE: drop_down uses orderindex here, but searchTasks custom_fields filter uses the option UUID — getAccessibleCustomFields returns both.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    fieldId: z.string().describe('The custom field ID (from getAccessibleCustomFields).'),
    value: z.any().describe('The value to set. Format depends on field type: text=string, number=number, dropdown=orderindex (integer), users=array of user IDs, checkbox=boolean, date=unix timestamp ms, labels=array of label UUIDs. NOTE: For dropdowns, setCustomFieldValue uses orderindex but searchTasks custom_fields filter uses the option UUID (id) — use getAccessibleCustomFields to get both.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.setCustomFieldValue(args.taskId, args.fieldId, args.value);
    return `Custom field ${args.fieldId} updated on task ${args.taskId}.`;
  },
});

clickUpServer.addTool({
  name: 'removeCustomFieldValue',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove/clear a custom field value from a ClickUp task.',
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
    name: z.string().optional().describe('New name for the list.'),
    content: z.string().optional().describe('New description/content.'),
    dueDate: z.string().optional().describe('New due date as ISO string.'),
    priority: z.number().int().min(1).max(4).optional().describe('Priority: 1=Urgent, 2=High, 3=Normal, 4=Low.'),
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
  description: 'List ClickUp Docs in a workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.listDocs(args.workspaceId);
    const docs = result.data || result.docs || [];
    if (docs.length === 0) return 'No docs found in this workspace.';
    return docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}\n  Created: ${d.date_created ? new Date(parseInt(d.date_created)).toISOString() : 'unknown'}`
    ).join('\n\n');
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
  description: 'Search ClickUp Docs in a workspace by name. Optionally filter by creator, parent, or status.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    query: z.string().optional().describe('Text to match against doc names (case-insensitive). Omit to list all docs.'),
    creator: z.number().optional().describe('Filter by creator user ID.'),
    parentId: z.string().optional().describe('Filter by parent ID (Space, Folder, or List).'),
    parentType: z.enum(['SPACE', 'FOLDER', 'LIST', 'EVERYTHING', 'WORKSPACE']).optional().describe('Type of parent to filter by.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.searchDocs(args.workspaceId, {
      creator: args.creator,
      parentId: args.parentId,
      parentType: args.parentType,
    });
    let docs = result.data || result.docs || [];
    // Client-side text filtering (ClickUp v3 API doesn't support text search)
    if (args.query) {
      const q = args.query.toLowerCase();
      docs = docs.filter((d: any) => {
        const name = (d.name || d.title || '').toLowerCase();
        return name.includes(q);
      });
    }
    if (docs.length === 0) return args.query ? `No docs found matching "${args.query}".` : 'No docs found in this workspace.';
    return docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'createDoc',
  annotations: { readOnlyHint: false },
  description: 'Create a new ClickUp Doc in a workspace. Optionally place it inside a Space, Folder, or List by providing parent ID and type.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    name: z.string().min(1).describe('Title of the new doc.'),
    content: z.string().optional().describe('Initial content of the doc (markdown supported).'),
    parentId: z.string().optional().describe('ID of the parent (Space, Folder, or List) to place the doc in.'),
    parentType: z.number().optional().describe('Type of parent: 4 = Space, 5 = Folder, 6 = List. Required if parentId is provided.'),
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
    name: z.string().optional().describe('Name of the new page.'),
    content: z.string().optional().describe('Content of the page (markdown).'),
    parentPageId: z.string().optional().describe('ID of the parent page for nesting.'),
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
    name: z.string().optional().describe('New name for the page.'),
    content: z.string().optional().describe('New content (markdown).'),
    editMode: z.enum(['replace', 'append', 'prepend']).optional().default('replace').describe('How to apply content: replace (default), append, or prepend.'),
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
