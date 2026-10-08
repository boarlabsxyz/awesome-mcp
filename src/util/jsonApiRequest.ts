// src/util/jsonApiRequest.ts
// One authenticated JSON request against a third-party REST API, with the four
// rules every client in this repo needs to get right.
//
// Extracted because these rules were being re-typed per connector and the
// copies are indistinguishable to a reader — the same reasoning that produced
// pasteTokenValidation.ts and baseUrlGuard.ts. Each rule is here because
// getting it wrong is either a security problem or an undiagnosable one:
//
//   1. Redirects are handled HERE, never by `fetch`. Node's fetch strips
//      `Authorization` across an origin change but KEEPS custom headers, so
//      letting it follow a redirect would hand an API-key header
//      (x-bb-api-key, X-Redmine-API-Key, …) to whatever host the Location
//      names. The mode is `'manual'` rather than `'error'` so the Location can
//      be READ before the call is refused: `'error'` produced a bare
//      "fetch failed" that named neither the status nor the target, which is
//      undiagnosable — the caller cannot tell a proxy rewrite from an SSO
//      bounce from a wrong base URL. A caller may opt into following hops, but
//      only same-origin ones, only on an idempotent method, and the credential
//      still never crosses an origin.
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

/**
 * Hard ceiling on followed hops, whatever a caller asks for.
 *
 * A redirect loop inside one origin is still a loop, and each hop spends a
 * request against someone else's rate limit. The deadline would eventually
 * stop it, but reporting "timed out" for a loop names the wrong problem.
 */
const MAX_REDIRECT_HOPS = 3;

/** What a refused redirect was, in the terms a caller needs to act on it. */
export interface RedirectRefusal {
  /** The 3xx status the upstream answered. */
  status: number;
  /** Raw `Location` header, verbatim (already redacted of known secrets). */
  location: string;
  /** Absolute resolved target, or null when `Location` would not parse. */
  resolved: string | null;
  /** Target host (with port when non-default), or null. */
  host: string | null;
  /** Target path + query, or null. Safe to show for a same-origin bounce. */
  path: string | null;
  /** True when scheme AND host match the ORIGINAL request, not just the last hop. */
  sameOrigin: boolean;
  /** True when the target looked like a sign-in page rather than a moved resource. */
  loginBounce: boolean;
  /** Same-origin hops already followed before this one was refused. */
  hopsFollowed: number;
}

/**
 * A 3xx that was not followed.
 *
 * Carries the target so a caller can tell the four cases apart — a proxy
 * rewrite, an SSO hop to another host, a login bounce on one route, and a
 * redirect loop — which a bare transport failure cannot. `.status` is the 3xx
 * itself so `sendUpstreamError` has something better than a flat 500.
 */
export class RedirectRefusedError extends Error {
  /**
   * 502, deliberately NOT the upstream 3xx.
   *
   * This is the one place the "put the upstream status on .status" rule is
   * wrong: sendUpstreamError passes the value straight to res.status(), and
   * answering our own REST client with a 302 would make it try to FOLLOW the
   * redirect — to a Location we never sent, having stripped the credential
   * precisely so it could not be followed. The upstream was reached but gave
   * no usable answer, which is what 502 means; the real 3xx stays on
   * `.redirect.status` and in the message.
   */
  readonly status = 502;
  readonly redirect: RedirectRefusal;
  constructor(message: string, redirect: RedirectRefusal) {
    super(message);
    this.name = 'RedirectRefusedError';
    this.redirect = redirect;
  }
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
  /**
   * Follow up to this many SAME-ORIGIN hops instead of refusing at the first.
   *
   * Omitted (the default) refuses every redirect, which is what every caller
   * wanted before one instance turned out to serve a single route through a
   * proxy rewrite. Capped at MAX_REDIRECT_HOPS regardless. Ignored for any
   * method but GET and HEAD: a 301/302 on a POST is replayable as a GET by the
   * spec and as the same POST by 307/308, and neither is worth risking a
   * duplicate write over — those still refuse and report the target.
   */
  followSameOriginRedirects?: number;
  /**
   * Which target paths mean "you are not signed in" rather than "it moved".
   *
   * A login page is never followed even when same-origin: the follow would
   * answer 200 with HTML, which parses as "no JSON" and resolves to undefined
   * — a sign-in page silently reported as an empty result. Recognising it is
   * what lets a caller try a different credential presentation instead.
   */
  isLoginPath?: (path: string) => boolean;
  /**
   * Values to scrub from anything that reaches a message, log or `.redirect`.
   *
   * Redmine's login bounce puts the whole original URL in `back_url`, so once a
   * caller retries with the key as a query parameter the Location itself
   * carries the credential. Without this the fallback would leak it into the
   * error text, the server log and the model transcript.
   */
  secrets?: readonly string[];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

function safeUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** 304 is a cache answer, not a relocation, and carries no Location. */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

/**
 * Turn a 3xx response into the facts a caller needs, with the credential
 * scrubbed out of the Location first.
 */
function describeRedirect(
  res: Response,
  requestUrl: string,
  origin: URL | null,
  hopsFollowed: number,
  config: JsonApiRequestConfig,
  redact: (text: string) => string,
): RedirectRefusal & { followUrl: string | null } {
  const rawLocation = res.headers.get('location') ?? '';
  const resolved = rawLocation ? safeUrl(rawLocation, requestUrl) : null;
  // Compared against the ORIGINAL request, not the previous hop: comparing
  // hop-to-hop would let a chain walk off-origin one same-origin step at a
  // time, which is the whole thing this guard exists to stop.
  const sameOrigin = Boolean(
    resolved && origin && resolved.protocol === origin.protocol && resolved.host === origin.host,
  );
  const path = resolved ? `${resolved.pathname}${resolved.search}` : null;
  return {
    followUrl: resolved ? resolved.toString() : null,
    status: res.status,
    location: redact(rawLocation),
    // Redacted, because this record is NOT module-local: it is reachable as
    // `RedirectRefusedError.redirect` from every caller, so anything that logs
    // or serialises the error prints whatever a `back_url` echoed back. The raw
    // URL a follow needs is `followUrl` above, which is stripped off before the
    // error is built.
    resolved: resolved ? redact(resolved.toString()) : null,
    host: resolved ? resolved.host : null,
    path: path ? redact(path) : null,
    sameOrigin,
    loginBounce: Boolean(path && config.isLoginPath?.(resolved!.pathname)),
    hopsFollowed,
  };
}

/** The message, which has to name which of the four cases this was. */
function redirectMessage(
  serviceLabel: string,
  target: string,
  r: RedirectRefusal,
  hopBudget: number,
  idempotent: boolean,
): string {
  const prefix = `${serviceLabel} ${target} was redirected (HTTP ${r.status})`;
  if (!r.resolved) {
    return `${prefix} but the Location header was missing or unparseable (${r.location || 'empty'}), so there was nothing to follow.`;
  }
  if (!r.sameOrigin) {
    // The one case where the host is the headline: a credential for this
    // instance has no business at another origin, so this is never followed
    // and never retried, however many hops the caller allowed.
    return `${prefix} to a DIFFERENT origin (${r.host}). The credential was NOT sent there — it is only valid for the instance you configured. This is usually an SSO or access proxy (Cloudflare Access, an OAuth2 proxy) in front of the API, which needs its own credential rather than this one.`;
  }
  if (r.loginBounce) {
    return `${prefix} to the sign-in page ${r.path} on the same host, which means the credential was not accepted on this route even though the host and base URL are right. A proxy stripping the auth header on this path, or the endpoint being disabled, both look like this.`;
  }
  if (hopBudget === 0) {
    // `idempotent` is the real request method, not something parsed out of
    // `target` — that is a caller-supplied label and says whatever the caller
    // wants it to.
    const why = idempotent
      ? ''
      : ' (the method is not idempotent, so replaying it could duplicate a write)';
    return `${prefix} to ${r.path} on the same host, and redirects are not followed for this call${why}.`;
  }
  return `${prefix} to ${r.path} on the same host and was still redirecting after ${r.hopsFollowed} hop(s) — the limit for this call. That is a redirect loop rather than a relocation.`;
}

function redactWith(secrets: readonly string[] | undefined, text: string): string {
  if (!secrets?.length) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue; // too short to redact without mangling ordinary text
    out = out.split(secret).join('[redacted]');
    out = out.split(encodeURIComponent(secret)).join('[redacted]');
  }
  return out;
}

/**
 * Perform the request and parse a JSON body.
 *
 * Resolves to `undefined` for 204 and for any non-JSON response. Throws with
 * `.status` and `.body` set for a non-2xx, `RedirectRefusedError` for a 3xx
 * that was not followed, and a named message on timeout.
 */
export async function jsonApiRequest<T>(config: JsonApiRequestConfig): Promise<T | undefined> {
  const { method, headers, body, timeoutMs, serviceLabel } = config;
  const doFetch = config.fetchImpl ?? fetch;
  const redact = (text: string) => redactWith(config.secrets, text);
  // `target` prefixes EVERY message this function can throw — the redirect, the
  // timeout and the non-2xx — and callers build it from the request path. Redmine's
  // login-bounce fallback retries with the key as a query parameter, so that path
  // carries the credential, and a 403 or a timeout on that attempt would put it in
  // the message, the server log and (via mapRedmineError) the text shown to the
  // model. Redacting the body and the Location while leaving this alone would have
  // defeated the whole point of `secrets`.
  const target = redact(config.target);

  const origin = safeUrl(config.url);
  const idempotent = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD';
  const hopBudget = idempotent
    ? Math.min(config.followSameOriginRedirects ?? 0, MAX_REDIRECT_HOPS)
    : 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => new Error(`${serviceLabel} ${target} timed out after ${timeoutMs}ms`);

  // The whole call, including body consumption, sits inside one try/finally so
  // the deadline stays armed until the body has been read. `fetch` resolves as
  // soon as the response HEADERS arrive, so clearing the timer at that point
  // would leave a stalled body stream to hang with no limit at all — the route
  // would then outlive its own configured deadline. The redirect loop is inside
  // the same block, so a chain of hops shares ONE deadline rather than getting
  // a fresh one each time — otherwise three hops could take 3× the configured
  // timeout.
  try {
    let url = config.url;
    let hopsFollowed = 0;
    let res: Response;

    for (;;) {
      try {
        res = await doFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          // 'manual' rather than 'error': the credential must still never
          // follow a redirect, but refusing without reading the Location first
          // is what made every one of these undiagnosable.
          redirect: 'manual',
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') throw timedOut();
        throw err;
      }

      if (!isRedirect(res.status)) break;

      // A 3xx body is never useful and is never read, but an undrained body
      // holds its socket in the pool. Cancelling is best-effort — a stub
      // response in a test has no body to cancel.
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }

      const refusal = describeRedirect(res, url, origin, hopsFollowed, config, redact);
      const { followUrl, ...refusalRecord } = refusal;
      const followable =
        hopsFollowed < hopBudget && refusal.sameOrigin && !refusal.loginBounce && followUrl;
      if (!followable) {
        throw new RedirectRefusedError(
          redirectMessage(serviceLabel, target, refusalRecord, hopBudget, idempotent),
          refusalRecord,
        );
      }
      // The RAW url, never the redacted `resolved` on the record — redacting it
      // there is what keeps a credential out of the error, and following a
      // string with "[redacted]" spliced into it would request a path that
      // does not exist.
      url = followUrl;
      hopsFollowed += 1;
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
      const error: any = new Error(`${serviceLabel} ${target} failed: ${res.status} ${truncate(redact(text))}`);
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
