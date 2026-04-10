// src/clickup/apiHelpers.ts
import { UserError } from 'fastmcp';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

export class ClickUpClient {
  constructor(private accessToken: string) {}

  private async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    const url = `${CLICKUP_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

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

  async createList(folderId: string, data: { name: string; content?: string; due_date?: number; priority?: number; assignee?: number; status?: string }): Promise<any> {
    return this.request('POST', `/folder/${folderId}/list`, data);
  }

  async createFolderlessList(spaceId: string, data: { name: string; content?: string }): Promise<any> {
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

  // === Search ===

  async searchTasks(teamId: string, query: string, page?: number): Promise<any> {
    const params = new URLSearchParams();
    params.set('name', query);
    if (page !== undefined) params.set('page', String(page));
    return this.request('GET', `/team/${teamId}/task?${params.toString()}`);
  }

  // === Comments ===

  async getTaskComments(taskId: string, start?: number, startId?: string): Promise<any> {
    const params = new URLSearchParams();
    if (start !== undefined) params.set('start', String(start));
    if (startId) params.set('start_id', startId);
    const qs = params.toString();
    return this.request('GET', `/task/${taskId}/comment${qs ? '?' + qs : ''}`);
  }

  async addTaskComment(taskId: string, data: { comment_text: string; assignee?: number; notify_all?: boolean }): Promise<any> {
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
    return this.request('GET', `/workspaces/${workspaceId}/docs`);
  }

  async searchDocs(workspaceId: string, query: string): Promise<any> {
    return this.request('GET', `/workspaces/${workspaceId}/docs?search=${encodeURIComponent(query)}`);
  }
}
