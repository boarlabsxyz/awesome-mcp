// src/clickup/apiHelpers.ts
import { UserError } from 'fastmcp';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const CLICKUP_API_V3_BASE = 'https://api.clickup.com/api/v3';

export interface CommentBlock {
  text: string;
  attributes?: Record<string, any>;
}

/**
 * Convert markdown text to ClickUp comment blocks.
 * Handles bold, italic, inline code, and plain text.
 * Each line becomes a separate segment ending with \n.
 */
export function markdownToCommentBlocks(markdown: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Parse inline formatting within each line
    const inlineRegex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(line)) !== null) {
      // Add plain text before this match
      if (match.index > lastIndex) {
        blocks.push({ text: line.slice(lastIndex, match.index) });
      }

      if (match[2]) {
        // ***bold italic***
        blocks.push({ text: match[2], attributes: { bold: true, italic: true } });
      } else if (match[3]) {
        // **bold**
        blocks.push({ text: match[3], attributes: { bold: true } });
      } else if (match[4]) {
        // *italic*
        blocks.push({ text: match[4], attributes: { italic: true } });
      } else if (match[5]) {
        // `inline code`
        blocks.push({ text: match[5], attributes: { code: true } });
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining plain text on this line
    if (lastIndex < line.length) {
      blocks.push({ text: line.slice(lastIndex) });
    }

    // Add newline after each line (except the last)
    if (i < lines.length - 1) {
      blocks.push({ text: '\n' });
    }
  }

  return blocks;
}

export class ClickUpClient {
  constructor(private accessToken: string) {}

  private async request<T = any>(method: string, path: string, body?: any, baseUrl: string = CLICKUP_API_BASE): Promise<T> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new UserError(`ClickUp API request timed out: ${method} ${path}`);
      }
      throw new UserError(`ClickUp API request failed (${method} ${path}): ${err.message || err}`);
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      throw new UserError('ClickUp rate limit exceeded. Please try again in a moment.');
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new UserError(`ClickUp API error (${res.status}): ${errText}`);
    }

    // Some endpoints return empty bodies (e.g., DELETE)
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // === User ===

  async getAuthorizedUser(): Promise<any> {
    return this.request('GET', '/user');
  }

  // === Workspaces (Teams) ===

  async getWorkspaces(): Promise<any> {
    return this.request('GET', '/team');
  }

  // === Spaces ===

  async getSpaces(teamId: string, archived?: boolean): Promise<any> {
    const params = archived ? '?archived=true' : '';
    return this.request('GET', `/team/${teamId}/space${params}`);
  }

  async createSpace(teamId: string, data: { name: string; multiple_assignees?: boolean; features?: any }): Promise<any> {
    return this.request('POST', `/team/${teamId}/space`, data);
  }

  // === Folders ===

  async getFolders(spaceId: string, archived?: boolean): Promise<any> {
    const params = archived ? '?archived=true' : '';
    return this.request('GET', `/space/${spaceId}/folder${params}`);
  }

  async createFolder(spaceId: string, data: { name: string }): Promise<any> {
    return this.request('POST', `/space/${spaceId}/folder`, data);
  }

  // === Lists ===

  async getListsInFolder(folderId: string, archived?: boolean): Promise<any> {
    const params = archived ? '?archived=true' : '';
    return this.request('GET', `/folder/${folderId}/list${params}`);
  }

  async getFolderlessLists(spaceId: string, archived?: boolean): Promise<any> {
    const params = archived ? '?archived=true' : '';
    return this.request('GET', `/space/${spaceId}/list${params}`);
  }

  async createList(folderId: string, data: { name: string; content?: string; markdown_content?: string; due_date?: number; priority?: number; assignee?: number; status?: string }): Promise<any> {
    return this.request('POST', `/folder/${folderId}/list`, data);
  }

  async createFolderlessList(spaceId: string, data: { name: string; content?: string; markdown_content?: string }): Promise<any> {
    return this.request('POST', `/space/${spaceId}/list`, data);
  }

  async updateList(listId: string, data: { name?: string; content?: string; due_date?: number; priority?: number; assignee_add?: number; assignee_rem?: number; unset_status?: boolean }): Promise<any> {
    return this.request('PUT', `/list/${listId}`, data);
  }

  async deleteList(listId: string): Promise<any> {
    return this.request('DELETE', `/list/${listId}`);
  }

  // === Tasks ===

  async getTasks(listId: string, params?: {
    archived?: boolean;
    page?: number;
    order_by?: string;
    reverse?: boolean;
    subtasks?: boolean;
    statuses?: string[];
    include_closed?: boolean;
    assignees?: string[];
    due_date_gt?: number;
    due_date_lt?: number;
  }): Promise<any> {
    const searchParams = new URLSearchParams();
    if (params?.archived) searchParams.set('archived', 'true');
    if (params?.page !== undefined) searchParams.set('page', String(params.page));
    if (params?.order_by) searchParams.set('order_by', params.order_by);
    if (params?.reverse) searchParams.set('reverse', 'true');
    if (params?.subtasks) searchParams.set('subtasks', 'true');
    if (params?.include_closed) searchParams.set('include_closed', 'true');
    if (params?.statuses) params.statuses.forEach(s => searchParams.append('statuses[]', s));
    if (params?.assignees) params.assignees.forEach(a => searchParams.append('assignees[]', a));
    if (params?.due_date_gt) searchParams.set('due_date_gt', String(params.due_date_gt));
    if (params?.due_date_lt) searchParams.set('due_date_lt', String(params.due_date_lt));
    const qs = searchParams.toString();
    return this.request('GET', `/list/${listId}/task${qs ? '?' + qs : ''}`);
  }

  async getTask(taskId: string, includeSubtasks?: boolean): Promise<any> {
    const params = includeSubtasks ? '?include_subtasks=true' : '';
    return this.request('GET', `/task/${taskId}${params}`);
  }

  async createTask(listId: string, data: {
    name: string;
    description?: string;
    markdown_content?: string;
    assignees?: number[];
    status?: string;
    priority?: number | null;
    due_date?: number;
    start_date?: number;
    tags?: string[];
    time_estimate?: number;
    parent?: string;
  }): Promise<any> {
    return this.request('POST', `/list/${listId}/task`, data);
  }

  async updateTask(taskId: string, data: {
    name?: string;
    description?: string;
    markdown_content?: string;
    status?: string;
    priority?: number | null;
    due_date?: number;
    start_date?: number;
    assignees?: { add?: number[]; rem?: number[] };
    time_estimate?: number;
    archived?: boolean;
    parent?: string;
  }): Promise<any> {
    return this.request('PUT', `/task/${taskId}`, data);
  }

  async deleteTask(taskId: string): Promise<any> {
    return this.request('DELETE', `/task/${taskId}`);
  }

  async moveTask(taskId: string, listId: string): Promise<any> {
    return this.request('POST', `/task/${taskId}`, { list_id: listId });
  }

  // === Custom Fields ===

  async getAccessibleCustomFields(listId: string): Promise<any> {
    return this.request('GET', `/list/${listId}/field`);
  }

  async setCustomFieldValue(taskId: string, fieldId: string, value: any): Promise<any> {
    return this.request('POST', `/task/${taskId}/field/${fieldId}`, { value });
  }

  async removeCustomFieldValue(taskId: string, fieldId: string): Promise<any> {
    return this.request('DELETE', `/task/${taskId}/field/${fieldId}`);
  }

  // === Search ===

  async searchTasks(teamId: string, query: string, page?: number, customFields?: Array<{ field_id: string; operator: string; value?: any }>, includeClosed?: boolean): Promise<any> {
    const params = new URLSearchParams();
    if (page !== undefined) params.set('page', String(page));
    if (includeClosed) params.set('include_closed', 'true');
    if (customFields?.length) params.set('custom_fields', JSON.stringify(customFields));
    const result = await this.request<any>('GET', `/team/${teamId}/task?${params.toString()}`);
    // ClickUp's filtered team tasks endpoint doesn't support name filtering server-side.
    // Apply client-side case-insensitive substring match when query is provided.
    if (query && result.tasks) {
      const q = query.toLowerCase();
      result.tasks = result.tasks.filter((t: any) => t.name?.toLowerCase().includes(q));
    }
    return result;
  }

  // === Comments ===

  async getTaskComments(taskId: string, start?: number, startId?: string): Promise<any> {
    const params = new URLSearchParams();
    if (start !== undefined) params.set('start', String(start));
    if (startId) params.set('start_id', startId);
    const qs = params.toString();
    return this.request('GET', `/task/${taskId}/comment${qs ? '?' + qs : ''}`);
  }

  async addTaskComment(taskId: string, data: { comment_text?: string; comment?: CommentBlock[]; assignee?: number; notify_all?: boolean }): Promise<any> {
    return this.request('POST', `/task/${taskId}/comment`, data);
  }

  // === Members ===

  async getTaskMembers(taskId: string): Promise<any> {
    return this.request('GET', `/task/${taskId}/member`);
  }

  // === Time Tracking ===

  async startTimeEntry(teamId: string, data: { tid: string; description?: string; billable?: boolean }): Promise<any> {
    return this.request('POST', `/team/${teamId}/time_entries/start`, data);
  }

  async stopTimeEntry(teamId: string): Promise<any> {
    return this.request('POST', `/team/${teamId}/time_entries/stop`);
  }

  async getTimeEntries(teamId: string, params?: {
    start_date?: number;
    end_date?: number;
    assignee?: string;
  }): Promise<any> {
    const searchParams = new URLSearchParams();
    if (params?.start_date) searchParams.set('start_date', String(params.start_date));
    if (params?.end_date) searchParams.set('end_date', String(params.end_date));
    if (params?.assignee) searchParams.set('assignee', params.assignee);
    const qs = searchParams.toString();
    return this.request('GET', `/team/${teamId}/time_entries${qs ? '?' + qs : ''}`);
  }

  // === Docs (v3 API) ===

  async listDocs(workspaceId: string): Promise<any> {
    return this.request('GET', `/workspaces/${workspaceId}/docs`, undefined, CLICKUP_API_V3_BASE);
  }

  async searchDocs(workspaceId: string, opts?: { creator?: number; parentId?: string; parentType?: string; deleted?: boolean; archived?: boolean; limit?: number }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.creator) params.set('creator', String(opts.creator));
    if (opts?.parentId) params.set('parent_id', opts.parentId);
    if (opts?.parentType) params.set('parent_type', opts.parentType);
    if (opts?.deleted !== undefined) params.set('deleted', String(opts.deleted));
    if (opts?.archived !== undefined) params.set('archived', String(opts.archived));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request('GET', `/workspaces/${workspaceId}/docs${qs ? `?${qs}` : ''}`, undefined, CLICKUP_API_V3_BASE);
  }

  async getDoc(workspaceId: string, docId: string): Promise<any> {
    return this.request('GET', `/workspaces/${workspaceId}/docs/${docId}`, undefined, CLICKUP_API_V3_BASE);
  }

  async getDocPages(workspaceId: string, docId: string): Promise<any> {
    return this.request('GET', `/workspaces/${workspaceId}/docs/${docId}/pages`, undefined, CLICKUP_API_V3_BASE);
  }

  async getPage(workspaceId: string, docId: string, pageId: string, contentFormat: string = 'text/md'): Promise<any> {
    return this.request('GET', `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}?content_format=${encodeURIComponent(contentFormat)}`, undefined, CLICKUP_API_V3_BASE);
  }

  async createPage(workspaceId: string, docId: string, data: { name?: string; sub_title?: string; content?: string; content_format?: string; parent_page_id?: string }): Promise<any> {
    return this.request('POST', `/workspaces/${workspaceId}/docs/${docId}/pages`, data, CLICKUP_API_V3_BASE);
  }

  async editPage(workspaceId: string, docId: string, pageId: string, data: { name?: string; sub_title?: string; content?: string; content_edit_mode?: string; content_format?: string }): Promise<any> {
    return this.request('PUT', `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, data, CLICKUP_API_V3_BASE);
  }

  async createDoc(workspaceId: string, data: { name: string; content?: string; parent?: { id: string; type: number } }): Promise<any> {
    return this.request('POST', `/workspaces/${workspaceId}/docs`, data, CLICKUP_API_V3_BASE);
  }
}
