// src/clickup/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { ClickUpClient } from './apiHelpers.js';

export const clickUpServer = new FastMCP<UserSession>({
  name: 'ClickUp MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'clickup'),
});

function getClickUpClient(session?: UserSession): ClickUpClient {
  if (!session?.clickUpAccessToken) {
    throw new UserError('ClickUp not connected. Visit the dashboard to connect your ClickUp account.');
  }
  return new ClickUpClient(session.clickUpAccessToken);
}

function formatTask(task: any): string {
  const parts = [
    `Task: ${task.name}`,
    `  ID: ${task.id}`,
    `  Status: ${task.status?.status || 'unknown'}`,
  ];
  if (task.priority) parts.push(`  Priority: ${task.priority.priority || task.priority}`);
  if (task.assignees?.length) parts.push(`  Assignees: ${task.assignees.map((a: any) => a.username || a.email).join(', ')}`);
  if (task.due_date) parts.push(`  Due: ${new Date(parseInt(task.due_date)).toISOString()}`);
  if (task.description) parts.push(`  Description: ${task.description.substring(0, 200)}${task.description.length > 200 ? '...' : ''}`);
  if (task.url) parts.push(`  URL: ${task.url}`);
  if (task.list) parts.push(`  List: ${task.list.name} (${task.list.id})`);
  if (task.tags?.length) parts.push(`  Tags: ${task.tags.map((t: any) => t.name).join(', ')}`);
  return parts.join('\n');
}

// === Tier 1: Core Navigation ===

clickUpServer.addTool({
  name: 'getAuthorizedUser',
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
  description: 'List tasks in a ClickUp list with optional filters.',
  parameters: z.object({
    listId: z.string().describe('The list ID to get tasks from.'),
    archived: z.boolean().optional().default(false).describe('Include archived tasks.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based). Each page returns up to 100 tasks.'),
    orderBy: z.enum(['id', 'created', 'updated', 'due_date']).optional().describe('Field to order by.'),
    reverse: z.boolean().optional().default(false).describe('Reverse the order.'),
    subtasks: z.boolean().optional().default(false).describe('Include subtasks.'),
    statuses: z.array(z.string()).optional().describe('Filter by status names.'),
    includeClosed: z.boolean().optional().default(false).describe('Include closed tasks.'),
    assignees: z.array(z.string()).optional().describe('Filter by assignee user IDs.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
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
    const tasks = result.tasks || [];
    if (tasks.length === 0) return 'No tasks found.';
    return tasks.map(formatTask).join('\n\n');
  },
});

// === Tier 2: Task CRUD ===

clickUpServer.addTool({
  name: 'createTask',
  description: 'Create a new task in a ClickUp list.',
  parameters: z.object({
    listId: z.string().describe('The list ID to create the task in.'),
    name: z.string().min(1).describe('Task name.'),
    description: z.string().optional().describe('Task description (supports markdown).'),
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
      description: args.description,
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
  description: 'Update an existing ClickUp task. Only provided fields will be changed.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to update.'),
    name: z.string().optional().describe('New task name.'),
    description: z.string().optional().describe('New description (supports markdown).'),
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
    if (args.description !== undefined) data.description = args.description;
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
  description: 'Add a comment to a ClickUp task.',
  parameters: z.object({
    taskId: z.string().describe('The task ID to comment on.'),
    commentText: z.string().min(1).describe('The comment text.'),
    assignee: z.number().optional().describe('User ID to assign (if creating an assigned comment).'),
    notifyAll: z.boolean().optional().default(true).describe('Notify all assignees and watchers.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.addTaskComment(args.taskId, {
      comment_text: args.commentText,
      assignee: args.assignee,
      notify_all: args.notifyAll,
    });
    return `Comment added to task ${args.taskId}. Comment ID: ${result.id}`;
  },
});

clickUpServer.addTool({
  name: 'getTaskComments',
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
  name: 'searchTasks',
  description: 'Search for tasks across a ClickUp workspace. Supports filtering by name and custom fields (e.g. Participants).',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID to search in.'),
    query: z.string().min(1).describe('Search query string.'),
    page: z.number().int().min(0).optional().describe('Page number (0-based).'),
    custom_fields: z.array(z.object({
      field_id: z.string().describe('The custom field ID.'),
      operator: z.enum(['=', '<', '>', '>=', '<=', '!=', 'IS NULL', 'IS NOT NULL', 'RANGE', 'ANY', 'ALL', 'NOT ANY', 'NOT ALL']).describe('Comparison operator.'),
      value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional().describe('Value to compare against. Use an array for ANY/ALL operators.'),
    })).optional().describe('Filter by custom fields. Each entry needs field_id, operator, and optionally value.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.searchTasks(args.workspaceId, args.query, args.page, args.custom_fields);
    const tasks = result.tasks || [];
    if (tasks.length === 0) return `No tasks found matching "${args.query}".`;
    return `Found ${tasks.length} task(s):\n\n` + tasks.map(formatTask).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'getAccessibleCustomFields',
  description: 'List all custom fields available on a ClickUp list. Use this to discover field IDs for filtering or setting values.',
  parameters: z.object({
    listId: z.string().describe('The list ID to get custom fields for.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.getAccessibleCustomFields(args.listId);
    const fields = result.fields || [];
    if (fields.length === 0) return 'No custom fields found on this list.';
    return `Found ${fields.length} custom field(s):\n\n` + fields.map((f: any) =>
      `Field: ${f.name}\n  ID: ${f.id}\n  Type: ${f.type}${f.type_config?.options ? `\n  Options: ${f.type_config.options.map((o: any) => o.name || o.label).join(', ')}` : ''}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'setCustomFieldValue',
  description: 'Set a custom field value on a ClickUp task. Use getAccessibleCustomFields first to find the field ID and type.',
  parameters: z.object({
    taskId: z.string().describe('The task ID.'),
    fieldId: z.string().describe('The custom field ID (from getAccessibleCustomFields).'),
    value: z.any().describe('The value to set. Format depends on field type: text=string, number=number, dropdown=option index or orderindex, users=array of user IDs, checkbox=boolean, date=unix timestamp ms, labels=array of label UUIDs.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    await client.setCustomFieldValue(args.taskId, args.fieldId, args.value);
    return `Custom field ${args.fieldId} updated on task ${args.taskId}.`;
  },
});

clickUpServer.addTool({
  name: 'removeCustomFieldValue',
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

clickUpServer.addTool({
  name: 'getTaskMembers',
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
  description: 'Create a new list in a ClickUp folder, or a folderless list in a space.',
  parameters: z.object({
    folderId: z.string().optional().describe('The folder ID (for a list inside a folder).'),
    spaceId: z.string().optional().describe('The space ID (for a folderless list). Used when folderId is not provided.'),
    name: z.string().min(1).describe('Name for the new list.'),
    content: z.string().optional().describe('Description/content for the list.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    if (!args.folderId && !args.spaceId) {
      throw new UserError('Provide either folderId or spaceId.');
    }
    const data = { name: args.name, content: args.content };
    const list = args.folderId
      ? await client.createList(args.folderId, data)
      : await client.createFolderlessList(args.spaceId!, data);
    return `List created:\n  Name: ${list.name}\n  ID: ${list.id}`;
  },
});

clickUpServer.addTool({
  name: 'createFolder',
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
  description: 'List ClickUp Docs in a workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.listDocs(args.workspaceId);
    const docs = result.docs || [];
    if (docs.length === 0) return 'No docs found in this workspace.';
    return docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}\n  Created: ${d.date_created ? new Date(parseInt(d.date_created)).toISOString() : 'unknown'}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'searchDocs',
  description: 'Search ClickUp Docs in a workspace.',
  parameters: z.object({
    workspaceId: z.string().describe('The workspace (team) ID.'),
    query: z.string().min(1).describe('Search query string.'),
  }),
  execute: async (args, { session }) => {
    const client = getClickUpClient(session);
    const result = await client.searchDocs(args.workspaceId, args.query);
    const docs = result.docs || [];
    if (docs.length === 0) return `No docs found matching "${args.query}".`;
    return docs.map((d: any) =>
      `Doc: ${d.name || d.title || 'Untitled'}\n  ID: ${d.id}`
    ).join('\n\n');
  },
});

clickUpServer.addTool({
  name: 'startTimeEntry',
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
