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

/**
 * How much upstream error text reaches the message.
 *
 * The body goes into `Error.message`, which gets logged and, for several
 * providers, rendered back to the user — so an upstream that answers a 500
 * with a megabyte of HTML would otherwise put all of it in both places. This
 * caps size only; it redacts nothing within what is kept, and the full body is
 * still on the error's non-enumerable `.body` for callers that parse it.
 */
const MAX_ERROR_TEXT = 500;

function truncate(text: string): string {
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT)}…(truncated, ${text.length} chars)`
    : text;
}

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
  const timedOut = () => new Error(`${serviceLabel} ${target} timed out after ${timeoutMs}ms`);

  // The whole call, including body consumption, sits inside one try/finally so
  // the deadline stays armed until the body has been read. `fetch` resolves as
  // soon as the response HEADERS arrive, so clearing the timer at that point
  // would leave a stalled body stream to hang with no limit at all — the route
  // would then outlive its own configured deadline.
  try {
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
      if (err?.name === 'AbortError') throw timedOut();
      throw err;
    }

    if (!res.ok) {
      // An unreadable error body is not worth failing over — but an ABORTED one
      // is the deadline firing, and must not be swallowed into an empty string
      // and reported as a plain upstream error.
      let text = '';
      try {
        text = await res.text();
      } catch (err: any) {
        if (err?.name === 'AbortError') throw timedOut();
      }
      const error: any = new Error(`${serviceLabel} ${target} failed: ${res.status} ${truncate(text)}`);
      error.status = res.status;
      // Non-enumerable: callers that need the raw body still read `err.body`,
      // but `console.error(err)` and JSON.stringify no longer dump an entire
      // upstream payload into the logs. The message carries a capped excerpt.
      Object.defineProperty(error, 'body', { value: text, enumerable: false, writable: true, configurable: true });
      throw error;
    }

    if (res.status === 204) return undefined;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return undefined;
    try {
      return (await res.json()) as T;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw timedOut();
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}
