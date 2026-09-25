// Render helpers for ClickUp tools.
//
// Extracted out of clickup/server.ts so the REST data plane (webServer.ts)
// can reuse the same markdown rendering when callers request
// `Accept: text/plain` on the JSON-default REST endpoints.

export function formatCustomFieldValue(cf: any): string {
  if (cf.value === null || cf.value === undefined) return '[empty]';
  if (cf.type === 'drop_down' && cf.type_config?.options) {
    const opt = cf.type_config.options.find((o: any) => String(o.orderindex) === String(cf.value));
    return opt ? `${opt.name} (id: ${opt.id})` : String(cf.value);
  }
  if (cf.type === 'labels' && Array.isArray(cf.value) && cf.type_config?.options) {
    return cf.value
      .map((uuid: string) => {
        const opt = cf.type_config.options.find((o: any) => o.id === uuid);
        return opt ? opt.label : uuid;
      })
      .join(', ');
  }
  if (cf.type === 'users' && Array.isArray(cf.value)) {
    return cf.value.map((u: any) => u.username || u.email || u.id).join(', ');
  }
  if (typeof cf.value === 'object') return JSON.stringify(cf.value);
  return String(cf.value);
}

// Preview cap for list-style renderings, where brevity is the point. The
// single-record tool (getTask) renders the full description instead — pass
// { fullDescription: true }.
const DESCRIPTION_PREVIEW_LIMIT = 200;

export function formatTask(task: any, opts: { fullDescription?: boolean } = {}): string {
  const parts = [
    `Task: ${task.name}`,
    `  ID: ${task.id}`,
    `  Status: ${task.status?.status || 'unknown'}`,
  ];
  if (task.priority) parts.push(`  Priority: ${task.priority.priority || task.priority}`);
  if (task.assignees?.length) parts.push(`  Assignees: ${task.assignees.map((a: any) => a.username || a.email).join(', ')}`);
  if (task.due_date) parts.push(`  Due: ${new Date(parseInt(task.due_date)).toISOString()}`);
  if (task.date_closed) parts.push(`  Closed: ${new Date(parseInt(task.date_closed)).toISOString()}`);
  if (task.date_created) parts.push(`  Created: ${new Date(parseInt(task.date_created)).toISOString()}`);
  if (task.date_updated) parts.push(`  Updated: ${new Date(parseInt(task.date_updated)).toISOString()}`);
  if (task.description) {
    if (opts.fullDescription || task.description.length <= DESCRIPTION_PREVIEW_LIMIT) {
      parts.push(`  Description: ${task.description}`);
    } else {
      // List rendering: keep the preview bounded, but state the true length so
      // the model knows text was dropped and can call getTask for the rest,
      // instead of treating the fragment as the complete description.
      const preview = task.description.substring(0, DESCRIPTION_PREVIEW_LIMIT);
      parts.push(
        `  Description: ${preview}… [truncated — showing ${DESCRIPTION_PREVIEW_LIMIT} of ${task.description.length} chars; call getTask for the full description]`,
      );
    }
  }
  // Rendered only when true: an "Archived: no" line on every row of a 100-task
  // list is noise, while an archived task showing up in one is worth flagging.
  // updateTask confirms the false direction itself -- see its archive note.
  if (task.archived) parts.push('  Archived: yes');
  if (task.url) parts.push(`  URL: ${task.url}`);
  if (task.list) parts.push(`  List: ${task.list.name} (${task.list.id})`);
  // ClickUp returns `parent` / `top_level_parent` as bare task IDs and carries
  // no parent NAME anywhere in the payload, so a list rendering can only print
  // the ID -- call getTask on it when the name is needed. Surfacing it here
  // rather than in each tool is what covers getTask/listTasks/filterTeamTasks/
  // searchTasks *and* the REST `Accept: text/plain` rendering from one place:
  // without it, rebuilding a hierarchy through MCP costs one getTask per node.
  if (task.parent) parts.push(`  Parent: ${task.parent}`);
  // Only interesting when it says something `parent` did not: for a first-level
  // subtask top_level_parent equals parent, and for a top-level task ClickUp may
  // echo the task's own id rather than null.
  if (task.top_level_parent && task.top_level_parent !== task.parent && task.top_level_parent !== task.id) {
    parts.push(`  Top-level parent: ${task.top_level_parent}`);
  }
  if (task.tags?.length) parts.push(`  Tags: ${task.tags.map((t: any) => t.name).join(', ')}`);
  if (task.custom_fields?.length) {
    const cfParts = task.custom_fields
      .filter((cf: any) => cf.value !== null && cf.value !== undefined)
      .map((cf: any) => `    ${cf.name}: ${formatCustomFieldValue(cf)}`);
    if (cfParts.length) parts.push(`  Custom Fields:\n${cfParts.join('\n')}`);
  }
  return parts.join('\n');
}

export function formatTaskList(tasks: any[]): string {
  if (!tasks || tasks.length === 0) return 'No tasks found.';
  return tasks.map((t) => formatTask(t)).join('\n\n');
}
