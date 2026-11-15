// src/browserbase/settings.ts
// Per-connection options for the hosted Browserbase MCP server, which it takes
// as query parameters (https://docs.browserbase.com/integrations/mcp/setup):
// the automation model and its API key, keep-alive, proxies and verified
// (Browserbase's anti-bot browser).
//
// Stored on the connection (providerTokens.browserbaseSettings), set from the
// dashboard, re-read per call. The model API key is a third-party secret the
// user supplies: it is write-only (the dashboard is told only whether one is
// set), and it is sent only in the upstream URL, which never leaves this
// server; responseSafety redacts `modelApiKey=` if Browserbase ever echoes it.

/** Browserbase's default when no model is named. */
export const BROWSERBASE_DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

export type BrowserbaseSettings = {
  /** provider/model, e.g. openai/gpt-4.1. Absent = Browserbase's default model. */
  modelName?: string;
  /** Key for that model's provider. Required by Browserbase for a non-default model. */
  modelApiKey?: string;
  /** Keep a session alive across disconnects. It still bills until released or timed out. */
  keepAlive?: boolean;
  /** Route through Browserbase proxies. */
  proxies?: boolean;
  /** Verified (anti-bot) browser. */
  verified?: boolean;
};

const MODEL_NAME = /^[a-z0-9][a-z0-9-]{0,40}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/;
/** A key is opaque, but never whitespace, never a URL, and bounded. */
const MODEL_API_KEY = /^[A-Za-z0-9._~+/=:-]{8,512}$/;

/**
 * Merge what the dashboard posts into the stored settings. `modelApiKey`:
 * a string replaces it, null clears it, absent keeps the stored one (the
 * dashboard never has it to send back).
 */
export function mergeBrowserbaseSettings(
  stored: BrowserbaseSettings | undefined,
  raw: unknown,
): { settings: BrowserbaseSettings } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'settings must be an object' };
  const r = raw as Record<string, unknown>;
  const out: BrowserbaseSettings = {};

  const model = typeof r.modelName === 'string' ? r.modelName.trim() : '';
  if (r.modelName !== undefined && r.modelName !== null && typeof r.modelName !== 'string') return { error: 'modelName must be a string' };
  if (model && model !== BROWSERBASE_DEFAULT_MODEL) {
    if (!MODEL_NAME.test(model)) return { error: 'modelName must be provider/model, e.g. openai/gpt-4.1' };
    out.modelName = model;
  }

  let key = stored?.modelApiKey;
  if (r.modelApiKey === null) key = undefined;
  else if (typeof r.modelApiKey === 'string' && r.modelApiKey.trim()) {
    const k = r.modelApiKey.trim();
    if (!MODEL_API_KEY.test(k)) return { error: 'modelApiKey does not look like an API key' };
    key = k;
  } else if (r.modelApiKey !== undefined && r.modelApiKey !== '') return { error: 'modelApiKey must be a string, or null to clear it' };
  if (out.modelName && !key) return { error: `A model other than ${BROWSERBASE_DEFAULT_MODEL} needs its provider's API key` };
  // A key with no model to use it for is not kept: it would sit unused, and a
  // stored secret nobody needs is only exposure.
  if (out.modelName && key) out.modelApiKey = key;

  // An omitted flag keeps its stored value, so a REST client posting only a
  // model does not silently switch proxies or keep-alive off.
  for (const flag of ['keepAlive', 'proxies', 'verified'] as const) {
    const value = r[flag] === undefined ? stored?.[flag] : r[flag];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { error: `${flag} must be true or false` };
    if (value) out[flag] = true;
  }
  return { settings: out };
}

/** What the dashboard may see: everything but the key itself. */
export function publicBrowserbaseSettings(s: BrowserbaseSettings = {}) {
  return {
    modelName: s.modelName ?? '',
    modelApiKeySet: Boolean(s.modelApiKey),
    keepAlive: Boolean(s.keepAlive),
    proxies: Boolean(s.proxies),
    verified: Boolean(s.verified),
    defaultModel: BROWSERBASE_DEFAULT_MODEL,
  };
}

/**
 * The hosted URL for these settings: the constant origin plus only the
 * documented parameters. Booleans must be the exact strings "true"/"false".
 */
export function hostedUrlFor(baseUrl: string, s: BrowserbaseSettings = {}): string {
  const url = new URL(baseUrl);
  if (s.modelName && s.modelApiKey) {
    url.searchParams.set('modelName', s.modelName);
    url.searchParams.set('modelApiKey', s.modelApiKey);
  }
  if (s.keepAlive) url.searchParams.set('keepAlive', 'true');
  if (s.proxies) url.searchParams.set('proxies', 'true');
  if (s.verified) url.searchParams.set('verified', 'true');
  return url.toString();
}
