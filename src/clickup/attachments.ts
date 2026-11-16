// src/clickup/attachments.ts
//
// Reading a file ClickUp hosts on its attachments CDN — the URL a Doc or task
// links (a meeting recording, an image, a PDF), shared by the REST download
// route and the getAttachmentInfo tool.
//
// ClickUp's public API documents no attachment download. The URLs are NOT
// public: anonymously the host answers 302 into a login flow
// (id.app.clickup.com/.../authz_token → app.clickup.com/login) whose end is a
// 200 HTML page. With an Authorization header the host answers 401 instead of
// redirecting (probed 2026-11-14), so it does evaluate the header; that the
// connection's OAuth token is ACCEPTED there is UNVERIFIED — check it first on
// a live run. Every way of not getting the file (401, a redirect into the login
// flow, a login page served as 200) is therefore reported as "token not
// accepted", never streamed to the caller as if it were the file.

import { UserError } from 'fastmcp';

/** ClickUp's attachments CDN; every workspace has its own `t<id>` subdomain. */
const ATTACHMENTS_DOMAIN = 'clickup-attachments.com';
const MAX_REDIRECTS = 3;
/** Covers connect + response headers only; a recording's body may stream for minutes. */
const HEADERS_TIMEOUT_MS = 30_000;

/** A bad `url` or `workspaceId` argument — the caller's to fix (REST: 400). */
export class AttachmentUrlError extends UserError {}

/**
 * Accept only `https://t<workspaceId>.p.clickup-attachments.com/t<workspaceId>/…`.
 *
 * This server fetches the URL with the connection's OAuth token attached, so
 * any other host is refused: it would be an SSRF primitive and would hand the
 * token to whoever runs that host.
 */
export function parseAttachmentUrl(raw: string, workspaceId: string): URL {
  if (!/^\d+$/.test(workspaceId)) {
    throw new AttachmentUrlError(`workspaceId must be a numeric ClickUp workspace (team) ID, got "${workspaceId}".`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AttachmentUrlError(`url is not a valid URL: ${raw}`);
  }
  const expectedHost = `t${workspaceId}.p.${ATTACHMENTS_DOMAIN}`;
  const shape = `https://${expectedHost}/t${workspaceId}/…`;
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new AttachmentUrlError(`Only ClickUp attachment URLs of this workspace are accepted (${shape}); got ${url.origin}.`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== expectedHost) {
    const other = /^t(\d+)\.p\.clickup-attachments\.com$/.exec(host);
    throw new AttachmentUrlError(other
      ? `This attachment belongs to workspace ${other[1]}, not ${workspaceId}. Pass workspaceId ${other[1]}.`
      : `Only ClickUp attachment URLs of this workspace are accepted (${shape}); got host ${host}.`);
  }
  if (!url.pathname.startsWith(`/t${workspaceId}/`)) {
    throw new AttachmentUrlError(`The URL path must start with /t${workspaceId}/ (${shape}); got ${url.pathname}.`);
  }
  return url;
}

/** Whether the connection's token can see `workspaceId` at all (GET /team). */
export function workspaceIsVisible(teamsResponse: any, workspaceId: string): boolean {
  const teams: any[] = Array.isArray(teamsResponse?.teams) ? teamsResponse.teams : [];
  return teams.some((t) => String(t?.id) === workspaceId);
}

export type AttachmentOpen =
  | { ok: true; response: Response }
  /** `status` is what the REST plane answers — never 401, which there means the caller's bearer. */
  | { ok: false; status: number; error: string; contentRange?: string };

function tokenNotAccepted(detail: string): AttachmentOpen {
  return {
    ok: false,
    status: 403,
    error:
      `ClickUp did not accept this connection's token for the attachment (${detail}). ` +
      'The file cannot be fetched through the connector; open it in ClickUp in a browser instead.',
  };
}

function isClickUpAppHost(host: string): boolean {
  return host === 'clickup.com' || host.endsWith('.clickup.com');
}

/**
 * Open an attachment URL with the connection's token and return the live
 * response, its body unread, for the caller to stream — or why it is not the
 * file. Redirects are followed by hand, only within the attachments domain, so
 * the token never leaves ClickUp's CDN.
 */
export async function openAttachment(
  accessToken: string,
  url: URL,
  opts: { range?: string; signal?: AbortSignal } = {},
): Promise<AttachmentOpen> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  // Abort events are not replayed: a caller that hung up before this point
  // (during the workspace lookup) would otherwise still start the CDN request.
  if (opts.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetch(current, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(opts.range ? { Range: opts.range } : {}),
          },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          return { ok: false, status: 504, error: `ClickUp attachments host did not answer within ${HEADERS_TIMEOUT_MS / 1000}s.` };
        }
        return { ok: false, status: 502, error: `Could not reach ClickUp attachments host: ${err?.message || err}` };
      }

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => { /* ignore */ });
        const next = new URL(location, current);
        const host = next.hostname.toLowerCase();
        if (isClickUpAppHost(host)) return tokenNotAccepted(`redirected to the ClickUp sign-in flow at ${host}`);
        if (next.protocol !== 'https:' || !host.endsWith(`.${ATTACHMENTS_DOMAIN}`)) {
          return { ok: false, status: 502, error: `ClickUp redirected the attachment to ${next.origin}; not followed (the token is only sent to ${ATTACHMENTS_DOMAIN}).` };
        }
        if (hop >= MAX_REDIRECTS) {
          return { ok: false, status: 502, error: `Too many redirects (>${MAX_REDIRECTS}) fetching the attachment.` };
        }
        current = next;
        continue;
      }

      if (res.ok) {
        // The sign-in flow ends in a 200 HTML page; that must not be saved as
        // the file. An attachment that IS an .html file is let through.
        const type = res.headers.get('content-type') || '';
        if (type.startsWith('text/html') && !/\.html?$/i.test(current.pathname)) {
          await res.body?.cancel().catch(() => { /* ignore */ });
          return tokenNotAccepted('ClickUp answered with an HTML page, not the file');
        }
        return { ok: true, response: res };
      }

      await res.body?.cancel().catch(() => { /* ignore */ });
      switch (res.status) {
        case 401: return tokenNotAccepted('ClickUp answered 401');
        case 403: return { ok: false, status: 403, error: 'ClickUp denied access to this attachment (403).' };
        case 404: return { ok: false, status: 404, error: 'Attachment not found (ClickUp answered 404).' };
        case 416: return {
          ok: false, status: 416, error: 'Requested range not satisfiable.',
          contentRange: res.headers.get('content-range') || undefined,
        };
        case 429: return { ok: false, status: 429, error: 'ClickUp rate limit exceeded. Please try again in a moment.' };
        default: return { ok: false, status: 502, error: `ClickUp attachments host answered ${res.status}.` };
      }
    }
  } finally {
    clearTimeout(timeout);
    // The caller's signal stays wired to `controller` on success: aborting it
    // (a client that hung up) must still cancel the body being streamed.
  }
}

/**
 * The file name to offer the caller: ClickUp's `filename` query parameter when
 * the link carries one, else the last path segment.
 */
export function attachmentFileName(url: URL): string {
  const fromQuery = url.searchParams.get('filename');
  if (fromQuery) return fromQuery;
  const last = url.pathname.split('/').filter(Boolean).pop();
  try {
    return last ? decodeURIComponent(last) : 'attachment';
  } catch {
    return last || 'attachment';
  }
}

/**
 * A name `curl -o` can safely write to: the file name without any directory
 * part, letters, digits and `_.-` only, never starting with a dot or dash.
 * The `filename` query parameter is whatever the link says, so
 * `filename=../../.bashrc` must not become a path outside the download folder.
 */
export function safeLocalFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  return base.replaceAll(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^[.-]+/, '') || 'attachment';
}

/** `Content-Disposition` with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replaceAll(/[^\w.-]+/g, '_') || 'attachment';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Total size from `Content-Range: bytes 0-0/12345`, else `Content-Length` of a 200. */
export function attachmentTotalSize(res: Response): number | null {
  const range = res.headers.get('content-range');
  const total = range ? /\/(\d+)\s*$/.exec(range)?.[1] : undefined;
  if (total) return Number(total);
  if (res.status === 200) {
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length >= 0 && res.headers.get('content-length') !== null) return length;
  }
  return null;
}

/** A `Range` request header this route forwards: `bytes=` ranges only. */
export function isForwardableRange(range: string): boolean {
  return /^bytes=\s*(\d*-\d*)(\s*,\s*\d*-\d*)*\s*$/.test(range) && range !== 'bytes=-';
}
