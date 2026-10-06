// src/util/jsonApiRequest.ts
// One authenticated JSON request against a third-party REST API, with the four
// rules every client in this repo needs to get right.
//
// Extracted because these rules were being re-typed per connector and the
// copies are indistinguishable to a reader — the same reasoning that produced
// pasteTokenValidation.ts and baseUrlGuard.ts. Each rule is here because
// getting it wrong is either a security problem or an undiagnosable one:
//
//   1. `redirect: 'error'`. Node's fetch strips `Authorization` across an
//      origin change but KEEPS custom headers, so following a redirect would
//      hand an API-key header (x-bb-api-key, X-Redmine-API-Key, …) to whatever
//      host the Location names. No REST API here has a legitimate redirect, so
//      one is treated as a failure rather than followed.
//   2. A deadline, surfaced as a named timeout rather than a bare AbortError —
//      which otherwise reaches the user as "The operation was aborted", a
//      message that names neither the service nor the call.
//   3. The upstream status on `.status` of the thrown error. sendUpstreamError
//      reads `err.code ?? err.response?.status ?? err.status`, so a status
//      stashed anywhere else (ClickUpClient tags it on a Symbol) is invisible
//      to it and every upstream 404 becomes a flat 500.
//   4. 204 and non-JSON answers resolve to undefined instead of throwing out of
//      res.json(). An empty body is a legitimate answer to a write.
//
// Used by BrowserbaseClient and RedmineClient. Each keeps only what is
// genuinely its own — Redmine its query-string builder and its dual-mode auth
// header, Browserbase its single key header. ClickUp and the others predate
// this and still carry their own copies; moving them over is worthwhile but is
// a bigger change than it looks, because ClickUpClient tags its status on a
// Symbol and ~24 of its REST routes currently depend on that quirk.

export interface JsonApiRequestConfig {
  /** Fully-built absolute URL, query string included. */
  url: string;
  method: string;
  /** Auth and content headers. Merged over the JSON defaults. */
  headers: Record<string, string>;
  /** Serialised as JSON when present. `undefined` sends no body. */
  body?: unknown;
  timeoutMs: number;
  /** Service name for error messages, e.g. "Browserbase API". */
  serviceLabel: string;
  /** What was attempted, for error messages, e.g. "GET /sessions". */
  target: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Perform the request and parse a JSON body.
 *
 * Resolves to `undefined` for 204 and for any non-JSON response. Throws with
 * `.status` and `.body` set for a non-2xx, and with a named message on timeout.
 */
export async function jsonApiRequest<T>(config: JsonApiRequestConfig): Promise<T | undefined> {
  const { url, method, headers, body, timeoutMs, serviceLabel, target } = config;
  const doFetch = config.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`${serviceLabel} ${target} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error: any = new Error(`${serviceLabel} ${target} failed: ${res.status} ${text}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }

  if (res.status === 204) return undefined;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return undefined;
  return (await res.json()) as T;
}
