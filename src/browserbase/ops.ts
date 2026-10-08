// src/browserbase/ops.ts
// One exported op per tool, so each can be driven against a stubbed proxy and a
// stubbed REST client in tests (the same split as src/redmine/ops.ts and
// HubSpot's op* functions). server.ts is reduced to addTool → schema → op.
//
// The proxy function is a parameter rather than an import so a test never has
// to intercept global fetch to exercise the formatting and fallback logic,
// which is where the behaviour that matters lives.

import { UserError } from 'fastmcp';
import { z } from 'zod';

import {
  BrowserbaseClient,
  BrowserbaseSession,
  sessionDashboardUrl,
} from './apiHelpers.js';
import {
  BrowserbaseAccessRules,
  assertDomainAllowed,
  describeRules,
} from './accessRules.js';
import {
  BrowserbaseHostedTool,
  parseSessionId,
  proxyHostedTool,
} from './mcpProxyClient.js';
import {
  extractNavigationFacts,
  safeErrorText,
  renderPayload,
  sanitize,
  sanitizeNote,
  unwrapEnvelope,
} from './responseSafety.js';
import {
  actSchema,
  endSchema,
  extractSchema,
  forceEndBrowserSessionSchema,
  getBrowserSessionSchema,
  listBrowserSessionsSchema,
  navigateSchema,
  observeSchema,
  startSchema,
} from './schemas.js';

/** Injected so tests need not stub global fetch. */
export type HostedProxy = (
  name: BrowserbaseHostedTool,
  args: Record<string, unknown>,
) => Promise<string>;

/** Bind a proxy to one connection's API key. */
export function hostedProxyFor(apiKey: string): HostedProxy {
  return (name, args) => proxyHostedTool(apiKey, name, args);
}

/**
 * Call a proxied tool, bounding whatever its failure says.
 *
 * `proxyHostedTool` already sanitizes, so for the real proxy this is
 * belt-and-braces — but deliberately so. Sanitizing at one choke point means
 * any future call site that builds its own proxy silently loses it, and the
 * failure mode is an unbounded upstream payload reaching the transcript. A live
 * run produced a ~214 KB error from one `extract`, so the cost of missing this
 * is a response no client can hold. Idempotent: re-sanitizing capped text is a
 * no-op.
 */
async function callProxy(
  proxy: HostedProxy,
  name: BrowserbaseHostedTool,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    return await proxy(name, args);
  } catch (err: any) {
    const safe = safeErrorText(err?.message ?? String(err));
    if (err instanceof UserError && err.message === safe) throw err;
    throw new UserError(safe);
  }
}

// ==================== Formatting ====================

/**
 * The reminder appended to every browser-tool response.
 *
 * Repetitive on purpose: a model that read `start`'s output ten messages ago
 * has every incentive to drop the id, and the failure when it does is an
 * opaque "no active session" rather than anything self-correcting.
 */
function sessionReminder(sessionId: string | undefined): string {
  if (!sessionId) return '';
  return `\n\nSession: ${sessionId} — pass sessionId: "${sessionId}" to every following browser call, and run end when finished so it stops billing.`;
}

/**
 * Turn whatever a proxied tool answered with into text that is safe and
 * consistent: the `{success,data}` envelope unwrapped, degenerate runs
 * collapsed, credentials and internal addresses redacted, and the whole thing
 * capped.
 *
 * Every proxied tool goes through this. The three findings it answers all came
 * from returning upstream text verbatim, so there is deliberately no path that
 * skips it.
 */
function renderProxied(text: string, fallback: string): string {
  const rendered = renderPayload(unwrapEnvelope(text));
  if (!rendered.trim()) return fallback;
  const safe = sanitize(rendered);
  return `${safe.text}${sanitizeNote(safe)}`;
}

export function formatSession(session: BrowserbaseSession): string {
  const lines: string[] = [`Session: ${session.id}`];
  if (session.status) lines.push(`Status: ${session.status}`);
  if (session.region) lines.push(`Region: ${session.region}`);
  if (session.createdAt) lines.push(`Created: ${session.createdAt}`);
  if (session.startedAt) lines.push(`Started: ${session.startedAt}`);
  // expiresAt is the cost ceiling — when Browserbase will end it on its own.
  if (session.expiresAt) lines.push(`Expires: ${session.expiresAt}`);
  if (session.endedAt) lines.push(`Ended: ${session.endedAt}`);
  if (session.keepAlive) lines.push('Keep-alive: on (survives disconnections — it will NOT stop when you disconnect)');
  if (session.contextId) lines.push(`Context: ${session.contextId}`);
  if (session.projectId) lines.push(`Project: ${session.projectId}`);
  lines.push(`Dashboard (live view and replay): ${sessionDashboardUrl(session.id)}`);
  return lines.join('\n');
}

export function formatSessionList(sessions: BrowserbaseSession[], status?: string): string {
  if (!sessions.length) {
    const scope = status ? `with status ${status}` : 'on this account';
    return `No browser sessions ${scope}.`;
  }

  // Lead with what is still costing money. A list sorted by creation date
  // buries the one fact a reader of this tool is looking for.
  const running = sessions.filter(s => s.status === 'RUNNING');
  const header = running.length
    ? `${sessions.length} session(s), ${running.length} still RUNNING and billing:`
    : `${sessions.length} session(s), none currently running:`;

  const rows = sessions.map(s => {
    const parts = [`• ${s.id}`, s.status ?? 'status unknown'];
    if (s.region) parts.push(s.region);
    if (s.createdAt) parts.push(`created ${s.createdAt}`);
    if (s.expiresAt && s.status === 'RUNNING') parts.push(`expires ${s.expiresAt}`);
    return parts.join(' — ');
  });

  const footer = running.length
    ? '\nClose any you are done with using forceEndBrowserSession — a running session bills until it is released or hits its timeout.'
    : '';

  return `${header}\n${rows.join('\n')}${footer}`;
}

// ==================== The six proxied browser tools ====================

/**
 * Create or reattach to a browser session.
 *
 * Two things happen beyond the proxy call. The returned id is parsed out and
 * put at the top of the response, because it is the contract every later call
 * depends on. And the session is then read over REST for its expiry, so the
 * cost of what was just created is visible at creation time rather than
 * discovered later — that read is best-effort, since failing a session that
 * was successfully created would be worse than not describing it.
 */
export async function opStart(
  proxy: HostedProxy,
  client: BrowserbaseClient,
  args: z.infer<typeof startSchema>,
  rules?: BrowserbaseAccessRules,
): Promise<string> {
  const text = await callProxy(proxy, 'start', args.sessionId ? { sessionId: args.sessionId } : {});
  const sessionId = parseSessionId(text) ?? args.sessionId;

  if (!sessionId) {
    // Do not report success: without an id the caller has nothing to pass to
    // the next call, and a browser may now be running that nobody can address.
    throw new UserError(
      `Browserbase started a session but did not return an id this tool could read, so later calls have nothing to target. ` +
        // Sanitized: this was the one exit that still echoed an upstream
        // payload verbatim, and `start`'s response is exactly the one that
        // carries the connect URL and its signing key.
        `Run listBrowserSessions to find and close it. Raw response: ${safeErrorText(text)}`,
    );
  }

  const parts = [`Browser session ready.`];
  let detail: string | undefined;
  try {
    detail = formatSession(await client.getSession(sessionId));
  } catch {
    // Best-effort: the session exists either way.
    detail = `Session: ${sessionId}\nDashboard (live view and replay): ${sessionDashboardUrl(sessionId)}`;
  }
  parts.push(detail);

  const ruleNote = describeRules(rules);
  if (ruleNote) parts.push(ruleNote);

  return `${parts.join('\n\n')}${sessionReminder(sessionId)}`;
}

/**
 * Close a session.
 *
 * The REST fallback is the whole point. The ticket's third scenario is "no
 * session left running and billing", so a proxy call that fails must not be
 * reported as a close — and REST `REQUEST_RELEASE` can reach a session even
 * when no MCP transport holds it, which is exactly the state a stranded
 * session is in. Which path closed it is stated, because "closed via the REST
 * API after the browser-control call failed" means something different for
 * whether the browser is reusable.
 */
export async function opEnd(
  proxy: HostedProxy,
  client: BrowserbaseClient,
  args: z.infer<typeof endSchema>,
): Promise<string> {
  const { sessionId } = args;
  try {
    const text = await callProxy(proxy, 'end', sessionId ? { sessionId } : {});
    const suffix = sessionId ? ` (${sessionId})` : '';
    // The upstream payload is dropped, not sanitized-and-echoed. `end` had no
    // sanitizing path at all, so it was returning the raw text — but the right
    // answer here is not to return it: a close either happened or it did not,
    // and the payload is a CDP fragment that tells the caller nothing. Echoing
    // a redacted version would just be noise with a redaction note attached.
    void text;
    return `Browser session closed${suffix}. It is no longer billing.`;
  } catch (proxyErr: any) {
    if (!sessionId) {
      throw new UserError(
        `Could not close the session: ${proxyErr?.message ?? proxyErr}. No sessionId was passed, so there is nothing to fall back to — ` +
          `run listBrowserSessions to find what is still RUNNING, then forceEndBrowserSession with its id.`,
      );
    }
    try {
      await client.releaseSession(sessionId);
      return (
        `Browser session ${sessionId} closed via the Browserbase REST API — it is no longer billing.\n\n` +
        `Note the browser-control call failed first (${proxyErr?.message ?? proxyErr}), so the session was released rather than shut down cleanly.`
      );
    } catch (restErr: any) {
      throw new UserError(
        `Could not close session ${sessionId}. The browser-control call failed (${proxyErr?.message ?? proxyErr}) and so did the ` +
          `REST release (${restErr?.message ?? restErr}). It may still be running and billing — check ` +
          `${sessionDashboardUrl(sessionId)} and close it there.`,
      );
    }
  }
}

/**
 * Navigate to a URL.
 *
 * The only place domain rules can be applied, because it is the only tool that
 * names a destination. Checked BEFORE the proxy call so a denied URL costs no
 * browser time.
 */
export async function opNavigate(
  proxy: HostedProxy,
  args: z.infer<typeof navigateSchema>,
  rules?: BrowserbaseAccessRules,
): Promise<string> {
  const url = assertDomainAllowed(rules, args.url);
  const text = await callProxy(proxy, 'navigate', {
    url: url.toString(),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });

  // The upstream payload is NOT echoed. `navigate` answers with a serialized
  // Page/CDP object — ~15 KB carrying the internal connect websocket URL, its
  // signingKey JWT several times over, internal cluster hostnames and a
  // flow-logger session id — so this projects the two facts worth reporting
  // and drops the rest. An allowlist rather than redaction on purpose: the
  // payload's shape is Browserbase's to change, and redaction can only remove
  // secrets that are already known about.
  const facts = extractNavigationFacts(unwrapEnvelope(text));
  const status = facts.status !== undefined ? ` (HTTP ${facts.status})` : '';
  const title = facts.title ? `\nTitle: ${facts.title}` : '';
  return `Navigated to ${url.toString()}${status}.${title}${sessionReminder(args.sessionId)}`;
}

export async function opAct(
  proxy: HostedProxy,
  args: z.infer<typeof actSchema>,
): Promise<string> {
  const text = await callProxy(proxy, 'act', {
    action: args.action,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });
  return `${renderProxied(text, 'Action performed.')}${sessionReminder(args.sessionId)}`;
}

export async function opObserve(
  proxy: HostedProxy,
  args: z.infer<typeof observeSchema>,
): Promise<string> {
  const text = await callProxy(proxy, 'observe', {
    instruction: args.instruction,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });
  return `${renderProxied(text, 'Nothing matching that instruction was found on the page.')}${sessionReminder(args.sessionId)}`;
}

export async function opExtract(
  proxy: HostedProxy,
  args: z.infer<typeof extractSchema>,
): Promise<string> {
  const text = await callProxy(proxy, 'extract', {
    ...(args.instruction ? { instruction: args.instruction } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });
  return `${renderProxied(text, 'Nothing was extracted from the page.')}${sessionReminder(args.sessionId)}`;
}

// ==================== The three REST session tools ====================

export async function opListBrowserSessions(
  client: BrowserbaseClient,
  args: z.infer<typeof listBrowserSessionsSchema>,
): Promise<string> {
  const sessions = await client.listSessions(args.status);
  return formatSessionList(sessions, args.status);
}

export async function opGetBrowserSession(
  client: BrowserbaseClient,
  args: z.infer<typeof getBrowserSessionSchema>,
): Promise<string> {
  const session = await client.getSession(args.sessionId);
  const usable =
    session.status === 'RUNNING'
      ? '\n\nThis session is live — pass its id to navigate / act / observe / extract.'
      : '\n\nThis session is not running, so browser calls against it will fail. Run start to create a new one.';
  return `${formatSession(session)}${usable}`;
}

export async function opForceEndBrowserSession(
  client: BrowserbaseClient,
  args: z.infer<typeof forceEndBrowserSessionSchema>,
): Promise<string> {
  const session = await client.releaseSession(args.sessionId);
  const status = session?.status ? ` Browserbase now reports it as ${session.status}.` : '';
  return `Requested release of session ${args.sessionId} — it is no longer billing.${status}`;
}
