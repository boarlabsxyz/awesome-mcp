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

export function formatTask(task: any): string {
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
  return tasks.map(formatTask).join('\n\n');
}
