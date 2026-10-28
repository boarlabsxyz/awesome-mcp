// Plain-text renderings of the usage queries for the Admin MCP.
//
// Every list says when it is capped and how much was left out: a model that
// reads "12 tools" when the real number is 212 will reason from a wrong total.
import type { AdminUser } from '../usage/adminUsers.js';
import type {
  UsageFilter,
  usageOverview,
  usageRetryLoops,
  usageToolStats,
  usageTopErrors,
  usageUserTimeline,
} from '../usage/usageQueries.js';

type Overview = Awaited<ReturnType<typeof usageOverview>>;
type ToolRow = Awaited<ReturnType<typeof usageToolStats>>[number];
type ErrorRow = Awaited<ReturnType<typeof usageTopErrors>>[number];
type LoopRow = Awaited<ReturnType<typeof usageRetryLoops>>[number];
type Timeline = Awaited<ReturnType<typeof usageUserTimeline>>;

export type ToolSortKey = 'calls' | 'errorRate' | 'users' | 'lastUsed';

const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`;
const who = (id: number, email: string | null) => email ?? `user #${id} (account deleted)`;

/** "last 7 days, service clickup, MCP only" — the scope every answer is about. */
export function describeFilter(f: UsageFilter): string {
  const parts = [`last ${f.days} day${f.days === 1 ? '' : 's'}`];
  if (f.slug) parts.push(`service ${f.slug}`);
  if (f.surface) parts.push(f.surface === 'mcp' ? 'MCP calls only' : 'REST calls only');
  return parts.join(', ');
}

export function formatOverview(o: Overview, f: UsageFilter): string {
  const lines = [`Usage — ${describeFilter(f)}`, ''];
  if (!o.totals.calls) {
    lines.push('No recorded calls in this period.');
    return lines.join('\n');
  }
  lines.push(
    `Calls: ${o.totals.calls} · Active users: ${o.totals.users} · Errors: ${o.totals.errors} (${pct(o.totals.errorRate)})`,
  );

  const bySlug = new Map<string, number>();
  for (const d of o.daily) bySlug.set(d.slug, (bySlug.get(d.slug) ?? 0) + d.calls);
  lines.push('', 'By service:');
  for (const [slug, calls] of [...bySlug].sort((a, b) => b[1] - a[1])) lines.push(`  ${slug}: ${calls}`);

  const byDay = new Map<string, number>();
  for (const d of o.daily) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.calls);
  lines.push('', 'Calls per day (UTC):');
  for (const [day, calls] of [...byDay].sort()) lines.push(`  ${day}: ${calls}`);

  if (o.clients.length) {
    lines.push('', 'Clients:');
    for (const c of o.clients) lines.push(`  ${c.client} (${c.surface}): ${c.calls} calls, ${c.users} users`);
  }
  if (o.topUsers.length) {
    lines.push('', `Top users (up to ${o.topUsers.length}):`);
    for (const u of o.topUsers) {
      lines.push(`  ${who(u.userId, u.email)} [id ${u.userId}]: ${u.calls} calls, ${u.errors} errors, ${u.tools} tools, last seen ${u.lastSeen ?? '-'}`);
    }
  }
  return lines.join('\n');
}

export const TOOL_USERS_SHOWN = 5;

export function sortTools(rows: ToolRow[], key: ToolSortKey): ToolRow[] {
  const val = (r: ToolRow) => (key === 'lastUsed' ? Date.parse(r.lastUsed ?? '') || 0 : r[key]);
  return [...rows].sort((a, b) => val(b) - val(a) || b.calls - a.calls);
}

export function formatToolUsage(rows: ToolRow[], f: UsageFilter, sortBy: ToolSortKey, limit: number): string {
  const head = `Tool usage — ${describeFilter(f)}`;
  if (!rows.length) return `${head}\n\nNo recorded calls in this period.`;
  const sorted = sortTools(rows, sortBy);
  const shown = sorted.slice(0, limit);
  const lines = [
    head,
    shown.length < sorted.length
      ? `Showing ${shown.length} of ${sorted.length} tools, sorted by ${sortBy}.`
      : `${sorted.length} tool(s), sorted by ${sortBy}.`,
    '',
  ];
  for (const t of shown) {
    const users = t.userList.slice(0, TOOL_USERS_SHOWN).map((u) => `${who(u.userId, u.email)} (${u.calls})`);
    const more = t.users - users.length;
    lines.push(
      `${t.slug} / ${t.tool}${t.surface === 'rest' ? ' [REST]' : ''}: ${t.calls} calls, ${t.errors} errors (${pct(t.errorRate)}), last used ${t.lastUsed ?? '-'}`,
      `  users (${t.users}): ${users.length ? users.join(', ') : 'none signed in'}${more > 0 ? `, and ${more} more` : ''}`,
    );
  }
  return lines.join('\n');
}

export function formatTopErrors(rows: ErrorRow[], f: UsageFilter): string {
  const head = `Top errors — ${describeFilter(f)}`;
  if (!rows.length) return `${head}\n\nNo failed calls in this period.`;
  const lines = [head, `${rows.length} error group(s) (at most 50), most frequent first.`, ''];
  for (const e of rows) {
    lines.push(
      `${e.slug} / ${e.tool} — ${e.kind ?? 'error'}: ${e.message || '(no message)'}`,
      `  ${e.calls} calls, ${e.users} users, last seen ${e.lastSeen ?? '-'}`,
    );
  }
  return lines.join('\n');
}

export function formatRetryLoops(rows: LoopRow[], f: UsageFilter): string {
  const head = `Retry loops — ${describeFilter(f)}`;
  const rule =
    'A loop is 4+ MCP calls to one tool in one session, each within 60s of the last. ' +
    'It is often a model retrying, but a batch (reading ten tasks) looks the same; runs containing failures are listed first.';
  if (!rows.length) return `${head}\n${rule}\n\nNo loops in this period.`;
  const lines = [head, rule, `${rows.length} loop(s) (at most 50).`, ''];
  for (const l of rows) {
    lines.push(
      `${who(l.userId, l.email)} [id ${l.userId}] — ${l.slug} / ${l.tool}: ${l.calls} calls, ${l.errors} failed, ${l.started ?? '-'} → ${l.ended ?? '-'}`,
    );
  }
  return lines.join('\n');
}

function argsText(ev: Timeline['events'][number]): string {
  const preview = ev.argPreview ?? {};
  const parts = ev.argKeys.map((k) => {
    if (!(k in preview)) return k;
    const v = (preview as Record<string, unknown>)[k];
    const shown = v && typeof v === 'object' ? `[${(v as any).type}, ${(v as any).length}]` : JSON.stringify(v);
    return `${k}=${shown}`;
  });
  return parts.length ? parts.join(', ') : 'no arguments';
}

export function formatTimeline(t: Timeline): string {
  const name = t.user.email ?? `user #${t.user.id} (account deleted)`;
  const head = `Activity for ${name} [id ${t.user.id}] — newest first. Argument values are shown only for search-type fields; other arguments are listed by name.`;
  if (!t.events.length) return `${head}\n\nNo recorded calls in the retention window.`;
  const lines = [head, ''];
  let lastSession: string | null | undefined;
  for (const ev of t.events) {
    const session = ev.sessionId ?? (ev.surface === 'rest' ? 'REST' : 'no session');
    if (session !== lastSession) {
      lines.push(`— session ${session}${ev.client ? ` · ${ev.client}${ev.clientVersion ? ' ' + ev.clientVersion : ''}` : ''}`);
      lastSession = session;
    }
    const result = ev.ok ? 'ok' : `${ev.errorKind ?? 'error'}${ev.errorMessage ? `: ${ev.errorMessage}` : ''}`;
    lines.push(`  ${ev.ts} ${ev.slug} / ${ev.tool} (${argsText(ev)}) → ${result}, ${ev.durationMs}ms`);
  }
  if (t.nextBefore) lines.push('', `More calls exist. Call again with before=${t.nextBefore} for older ones.`);
  return lines.join('\n');
}

export function formatUsers(users: AdminUser[], query: string | undefined, limit: number): string {
  const head = query ? `Users matching "${query}"` : 'Users';
  if (!users.length) return `${head}\n\nNo users${query ? ' match' : ''}.`;
  const shown = users.slice(0, limit);
  const lines = [
    head,
    shown.length < users.length ? `Showing ${shown.length} of ${users.length}.` : `${users.length} user(s).`,
    '',
  ];
  for (const u of shown) {
    const created = u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 10) : '-';
    lines.push(`${u.email}${u.name ? ` (${u.name})` : ''} — id ${u.id ?? 'none (file store)'}, ${u.authMethod ?? 'unknown'} sign-in, joined ${created}`);
    if (u.connectionsUnavailable) {
      lines.push('  connections: COULD NOT BE READ — not the same as having none');
    } else if (!u.connections.length) {
      lines.push('  connections: none');
    } else {
      for (const c of u.connections) lines.push(`  · ${c.mcpSlug} "${c.instanceName}"${c.googleEmail ? ` (${c.googleEmail})` : ''}`);
    }
  }
  return lines.join('\n');
}
