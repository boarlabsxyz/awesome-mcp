// Render helpers for ClickUp tools.
//
// Extracted out of clickup/server.ts so the REST data plane (webServer.ts)
// can reuse the same markdown rendering when callers request
// `Accept: text/plain` on the JSON-default REST endpoints.

import { COMMENTS_PAGE_SIZE } from './apiHelpers.js';

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
  // Task type. ClickUp ships a bare `custom_item_id` number and no name, so
  // this is the ID; listTaskTypes resolves it. Rendered only when it is a real
  // type -- 0 is the default "Task" and a line saying so on every row of a
  // 100-task list carries no information.
  if (typeof task.custom_item_id === 'number' && task.custom_item_id !== 0) {
    parts.push(`  Task type: ${task.custom_item_id === 1 ? 'Milestone (1)' : task.custom_item_id}`);
  }
  if (task.archived) parts.push('  Archived: yes');
  if (task.url) parts.push(`  URL: ${task.url}`);
  if (task.list) parts.push(`  List: ${task.list.name} (${task.list.id})`);
  // Tasks in Multiple Lists. Without this, addTaskToList is write-only: a task
  // could be shared into three more lists with no tool in this server able to
  // show it. Rendering the *extra* lists only, rather than `locations` verbatim,
  // is what keeps it silent for the overwhelmingly common single-list task --
  // ClickUp's schema calls `locations` "Lists where the task has been added"
  // without saying whether the home list is among them, and subtracting
  // `task.list` is correct either way (same suppression rule as
  // `Top-level parent`, which may or may not echo the task's own id).
  if (Array.isArray(task.locations)) {
    const extra = task.locations.filter((l: any) => l && String(l.id) !== String(task.list?.id));
    if (extra.length) {
      parts.push(`  Also in lists: ${extra.map((l: any) => `${l.name ?? 'unnamed'} (${l.id})`).join(', ')}`);
    }
  }
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

/** One comment, with its full text. The previous 300-char cut was silent --
 *  no ellipsis, no length -- so thread content vanished with no way for the
 *  caller to tell. Same reasoning as getTask's full description. */
export function formatComment(c: any): string {
  const author = c?.user?.username || c?.user?.email || 'unknown';
  const date = c?.date ? new Date(parseInt(String(c.date), 10)).toISOString() : 'unknown date';
  const text = c?.comment_text
    || (Array.isArray(c?.comment) ? c.comment.map((p: any) => p.text || '').join('') : '')
    || '[empty]';
  // Threaded replies live behind GET /comment/{id}/reply, which is not exposed
  // here and takes no paging parameters. Printing the count is the only thing
  // that keeps a threaded discussion from being invisible rather than merely
  // unread.
  const replies = Number(c?.reply_count) > 0 ? ` [${c.reply_count} threaded repl${Number(c.reply_count) === 1 ? 'y' : 'ies'}, not included]` : '';
  const resolved = c?.resolved ? ' [resolved]' : '';
  return `Comment by ${author} (${date})${resolved}${replies}:\n  ${text}`;
}

/**
 * Render a comment scan, stating the count, the order, and -- the point of the
 * whole thing -- whether this is every comment on the task.
 *
 * ClickUp hands back the newest 25 per request with no total and no cursor in
 * the response, so a bare list of comments cannot be told apart from a list
 * that was cut off. Every incomplete outcome is named, with the cursor to
 * continue from when there is one.
 */
export function formatTaskComments(
  scan: {
    comments: any[];
    pagesScanned: number;
    complete: boolean;
    hitCap: boolean;
    hitLimit: boolean;
    stalled: boolean;
    rateLimited: boolean;
    cursorUnavailable: boolean;
    nextStart?: string;
    nextStartId?: string;
  },
  opts: { oldestFirst?: boolean } = {},
): string {
  const ordered = opts.oldestFirst ? [...scan.comments].reverse() : scan.comments;
  const order = opts.oldestFirst ? 'oldest first' : 'newest first';
  const n = ordered.length;

  if (n === 0) {
    // An empty first page is a real "no comments"; an empty result after a
    // failed scan is not, and must not read as one.
    if (scan.complete || scan.pagesScanned === 0) return 'No comments on this task.';
    return `No comments returned, but the scan did not complete (${scanReason(scan)}). This is NOT evidence that the task has no comments.`;
  }

  const head = scan.complete
    ? `${n} comment(s) on this task — the complete history, ${order}:`
    : `${n} comment(s), ${order} — INCOMPLETE: ${scanReason(scan)}`;

  const parts = [head, '', ordered.map(formatComment).join('\n\n')];

  if (!scan.complete) {
    if (scan.nextStart && scan.nextStartId) {
      parts.push('', `To continue from where this stopped, call again with start=${scan.nextStart} and startId=${scan.nextStartId} (both are required; ClickUp ignores one without the other).`);
    } else if (scan.cursorUnavailable) {
      parts.push('', 'No resume cursor could be built: the comment to page from carried no id or no date, and ClickUp offers no other way to reach older comments.');
    }
  }

  return parts.join('\n');
}

/** Why a scan stopped short. Precedence matters: the caller's own limit is a
 *  better explanation than anything else that was also true. */
function scanReason(scan: {
  pagesScanned: number;
  hitCap: boolean;
  hitLimit: boolean;
  stalled: boolean;
  rateLimited: boolean;
  cursorUnavailable: boolean;
}): string {
  if (scan.hitLimit) return 'stopped at the requested limit, so older comments remain unread';
  if (scan.rateLimited) return `ClickUp rate-limited the scan after ${scan.pagesScanned} page(s), so older comments remain unread`;
  if (scan.hitCap) return `stopped at the ${scan.pagesScanned}-page cap (${scan.pagesScanned * COMMENTS_PAGE_SIZE} comments), so older comments remain unread`;
  if (scan.stalled) return 'ClickUp returned the same page again for the next cursor, so paging could not advance past these';
  if (scan.cursorUnavailable) return 'paging could not continue because the oldest comment fetched carried no id or date';
  return 'the scan stopped before a short page confirmed the end of the history';
}
