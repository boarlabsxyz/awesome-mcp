// src/pinecone/accessRules.ts
// Per-connection index/namespace rules and the read-only switch for the
// Pinecone connector, stored under providerTokens.accessRules exactly like
// Slack's channel rules and Browserbase's domain rules.
//
// Shape is Browserbase's: PURE, synchronous assert* functions, with the one
// piece of I/O (reading providerTokens) in a thin async wrapper in server.ts.
// Everything worth testing then lives in the pure functions.
//
// ---------------------------------------------------------------------------
// UNLIKE BROWSERBASE, THIS IS A BOUNDARY, NOT A GUARDRAIL — within this
// connector's surface. Browserbase can only enforce on `navigate`, because
// `act` can click a link anywhere. Here every tool that touches data NAMES its
// index and namespace as a parameter; there is no equivalent of "the page
// navigated itself". So the rules below hold for all nine tools, and the tool
// descriptions may say so without qualification.
//
// What they are still NOT: a limit on the API key. The key is a full-privilege
// Pinecone credential held by the user, who can point curl at the same project.
// These rules constrain what THIS CONNECTOR will do with it — which is the
// thing an agent can be talked into misusing — and nothing else.
// ---------------------------------------------------------------------------

import { UserError } from 'fastmcp';

export type PineconeDenialReason =
  | 'index-allowlist-miss'
  | 'index-blocklist-hit'
  | 'namespace-allowlist-miss'
  | 'namespace-blocklist-hit'
  | 'read-only'
  | 'rules-unavailable';

export interface DeniedTarget {
  index: string;
  namespace?: string;
  reason: PineconeDenialReason;
}

export class PineconeAccessDenied extends UserError {
  readonly reason: PineconeDenialReason;
  readonly indexName?: string;
  readonly namespace?: string;
  /** The user's own patterns, so the message can say what to edit. */
  readonly patterns?: string[];
  /** Populated only on the cascading-search path; every refused target. */
  readonly deniedTargets?: DeniedTarget[];

  constructor(
    message: string,
    detail: {
      reason: PineconeDenialReason;
      indexName?: string;
      namespace?: string;
      patterns?: string[];
      deniedTargets?: DeniedTarget[];
    },
  ) {
    super(message);
    this.name = 'PineconeAccessDenied';
    this.reason = detail.reason;
    this.indexName = detail.indexName;
    this.namespace = detail.namespace;
    this.patterns = detail.patterns;
    this.deniedTargets = detail.deniedTargets;
  }
}

export interface PineconeAccessRules {
  /** Index names this connection may touch. Empty/absent = any. */
  allowedIndexes?: string[];
  /** Index names this connection may never touch. Outranks the allowlist. */
  blockedIndexes?: string[];
  /** Namespaces this connection may touch. `""` is the default namespace. */
  allowedNamespaces?: string[];
  /** Namespaces this connection may never touch. Outranks the allowlist. */
  blockedNamespaces?: string[];
  /** Refuse create-index-for-model and upsert-records. Persisted even when false. */
  readOnly?: boolean;
}

/** The shape stored in providerTokens for this provider. */
export interface PineconeTokens {
  access_token?: string;
  accessRules?: PineconeAccessRules;
}

/**
 * The three concerns here do not share a failure posture, which is why this is
 * a discriminated union and not `PineconeAccessRules | undefined`.
 *
 * Browserbase's getRules collapses a read FAILURE into a read that found
 * NOTHING, and that is right there: stored-nothing means unrestricted, so the
 * two cases have the same answer. Here they do not. Stored-nothing means
 * "unrestricted reads AND writes allowed" — but a failed read must not be
 * allowed to mean "writes allowed", because the user may have flipped
 * readOnly and a database blip would then silently un-flip it. A refused
 * write is retryable; an upsert into a production index is not.
 *
 * So the caller hands this state to every assert*, and the POLICY lives in the
 * pure functions (which are testable) rather than in server.ts (which is not).
 */
export type PineconeRulesState =
  | { status: 'loaded'; rules?: PineconeAccessRules }
  | { status: 'unavailable'; detail: string };

/**
 * The tools that mutate, and therefore the ones that must call
 * assertWriteAllowed as their FIRST statement.
 *
 * Exported so a test can assert the list matches what server.ts actually
 * gates. Fail-open on `unavailable` is only ever reachable from a read tool
 * BECAUSE both of these gate first — if a third write tool is added without
 * that line, nothing else in the design would catch it.
 */
export const PINECONE_WRITE_TOOLS = ['create-index-for-model', 'upsert-records'] as const;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Does `name` match `pattern`? Exact literal comparison, lowercased.
 *
 * Deliberately NOT Browserbase's label-boundary suffix match and NOT Slack's
 * matchGlob. Suffix matching needs a separator to anchor to — `example.com`
 * works because `.` is a real boundary. A Pinecone index name is a single flat
 * DNS-ish token (lowercase alphanumerics and hyphens, no dots), so a suffix
 * rule would match `prod` against `not-prod` with no boundary to stop it, and
 * a prefix glob `prod-*` would be an unauditable blast radius an LLM could
 * propose widening. Users have a handful of indexes, not thousands; listing
 * them is cheap and the rule is then readable at a glance.
 *
 * Extension note: adding a trailing `-*` form later is backwards compatible
 * (every exact name stays valid). Removing one would not be. Start narrow.
 */
export function indexMatchesPattern(pattern: string, name: string): boolean {
  return String(pattern ?? '').trim().toLowerCase() === String(name ?? '').trim().toLowerCase();
}

/**
 * Case-SENSITIVE, unlike the index comparison.
 *
 * Pinecone index names are normalised to lowercase by the control plane, so
 * folding case there cannot widen a rule. Namespaces are opaque strings the
 * user invented: `Prod` and `prod` are two different namespaces holding
 * different vectors, so folding here would make one allowlist entry silently
 * grant both.
 *
 * Not trimmed either, for the same reason — a namespace may legitimately carry
 * leading or trailing whitespace, and normalising it away would match a rule
 * against a namespace it does not name.
 */
export function namespaceMatchesPattern(pattern: string, namespace: string): boolean {
  return String(pattern ?? '') === String(namespace ?? '');
}

/** Normalise an index rule list, dropping blanks. */
export function toIndexList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    const s = String(v ?? '').trim().toLowerCase();
    if (s) seen.add(s);
  }
  return [...seen];
}

/**
 * Normalise a namespace rule list, de-duping but PRESERVING `""`.
 *
 * THE DEFAULT NAMESPACE IS THE EMPTY STRING, and an allowlist that cannot
 * express it is a rule set that silently forbids the namespace most users
 * actually write to.
 *
 * Browserbase's webServer `toList` drops blanks — correct for a hostname — and
 * reusing it here would delete the default-namespace entry on every save: the
 * rule would vanish from storage and the user would watch their own checkbox
 * un-tick itself. That is why this is exported from here rather than written
 * inline in the dashboard route.
 *
 * A sentinel token (`(default)`, `__default__`) was the obvious alternative and
 * is rejected: Pinecone namespaces are user-chosen strings, so any sentinel is
 * a name a real namespace could have, and the collision resolves in the
 * dangerous direction (one entry grants two namespaces). Keeping the sentinel
 * display-only — see describeNamespace — means the ambiguity is cosmetic prose,
 * never semantics.
 */
export function toNamespaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    if (v === null || v === undefined) continue;
    seen.add(String(v));
  }
  return [...seen];
}

function indexPatterns(rules: PineconeAccessRules | undefined, key: 'allowedIndexes' | 'blockedIndexes'): string[] {
  return toIndexList(rules?.[key]);
}

function namespacePatterns(
  rules: PineconeAccessRules | undefined,
  key: 'allowedNamespaces' | 'blockedNamespaces',
): string[] {
  return toNamespaceList(rules?.[key]);
}

/** True when a rule set would restrict which indexes are reachable. */
export function hasIndexRules(rules?: PineconeAccessRules): boolean {
  return indexPatterns(rules, 'allowedIndexes').length > 0 || indexPatterns(rules, 'blockedIndexes').length > 0;
}

/** True when a rule set would restrict which namespaces are reachable. */
export function hasNamespaceRules(rules?: PineconeAccessRules): boolean {
  return (
    namespacePatterns(rules, 'allowedNamespaces').length > 0 ||
    namespacePatterns(rules, 'blockedNamespaces').length > 0
  );
}

/** Render a namespace for a human. The default namespace is `""` on the wire. */
export function describeNamespace(ns: string): string {
  return ns === '' ? '(default namespace)' : `"${ns}"`;
}

// ---------------------------------------------------------------------------
// Dashboard-shared validators
// ---------------------------------------------------------------------------

/**
 * Validate an index-name pattern a user typed into the dashboard.
 *
 * Returns null when fine, or the reason it was refused. Kept here rather than
 * in webServer so the dashboard route and the matcher cannot disagree — a
 * pattern the dashboard accepts but the matcher can never match is the one
 * failure this sharing exists to prevent.
 */
export function validateIndexPattern(pattern: string): string | null {
  const raw = String(pattern ?? '').trim();
  if (!raw) return 'Index name is empty.';
  if (raw.length > 45) return `"${raw.slice(0, 40)}…" is longer than a Pinecone index name can be (45 characters).`;
  if (raw.includes('*')) {
    return `"${raw}" contains a wildcard. Index rules are exact names — a wildcard an agent could propose widening is deliberately not supported.`;
  }
  if (raw !== raw.toLowerCase()) {
    return `"${raw}" has uppercase letters. Pinecone stores index names in lowercase, so this rule would never match — enter "${raw.toLowerCase()}".`;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(raw)) {
    return `"${raw}" is not a valid Pinecone index name. Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.`;
  }
  return null;
}

/**
 * Validate a namespace pattern.
 *
 * `""` is VALID and means the default namespace — the dashboard surfaces it as
 * an explicit checkbox rather than a text row, because an empty text input is
 * indistinguishable from one the user simply has not filled in yet.
 */
export function validateNamespacePattern(pattern: string): string | null {
  if (pattern === '') return null;
  const raw = String(pattern ?? '');
  if (raw.length > 500) return `That namespace name is longer than Pinecone allows (500 characters).`;
  if (raw.trim() === '') {
    return 'A namespace of only whitespace is almost certainly a mistake. For the default namespace, use the "Include the default namespace" option.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

function rulesOf(state: PineconeRulesState): PineconeAccessRules | undefined {
  return state.status === 'loaded' ? state.rules : undefined;
}

/**
 * Why is this index refused, if it is? Pure, shared by the assert and the
 * cascading-search collector so one cannot drift from the other.
 */
function denyIndexReason(
  rules: PineconeAccessRules | undefined,
  indexName: string,
): { reason: PineconeDenialReason; patterns: string[]; matched?: string } | null {
  const blocked = indexPatterns(rules, 'blockedIndexes');
  // Blocklist first: an explicit block outranks an allowlist entry that would
  // otherwise permit it, so the narrower rule wins. Same order as
  // assertDomainAllowed.
  const blockHit = blocked.find(p => indexMatchesPattern(p, indexName));
  if (blockHit) return { reason: 'index-blocklist-hit', patterns: blocked, matched: blockHit };

  const allowed = indexPatterns(rules, 'allowedIndexes');
  if (allowed.length > 0 && !allowed.some(p => indexMatchesPattern(p, indexName))) {
    return { reason: 'index-allowlist-miss', patterns: allowed };
  }
  return null;
}

function denyNamespaceReason(
  rules: PineconeAccessRules | undefined,
  namespace: string,
): { reason: PineconeDenialReason; patterns: string[]; matched?: string } | null {
  const blocked = namespacePatterns(rules, 'blockedNamespaces');
  const blockHit = blocked.find(p => namespaceMatchesPattern(p, namespace));
  if (blockHit) return { reason: 'namespace-blocklist-hit', patterns: blocked, matched: blockHit };

  const allowed = namespacePatterns(rules, 'allowedNamespaces');
  if (allowed.length > 0 && !allowed.some(p => namespaceMatchesPattern(p, namespace))) {
    return { reason: 'namespace-allowlist-miss', patterns: allowed };
  }
  return null;
}

function renderPatternList(patterns: string[], kind: 'index' | 'namespace'): string {
  if (!patterns.length) return 'none';
  return kind === 'namespace' ? patterns.map(describeNamespace).join(', ') : patterns.join(', ');
}

/**
 * Enforce the index rules.
 *
 * Fails OPEN when the rules could not be read: the stored default is
 * unrestricted, so refusing every read for a database blip would break the
 * connector while protecting nothing the user asked to protect. That is safe
 * only because both write tools gate on assertWriteAllowed first — see
 * PINECONE_WRITE_TOOLS.
 *
 * `intent: 'create'` changes only the wording. A brand-new index cannot be on
 * an allowlist, and the three options were refuse-always, create-then-be-
 * unable-to-use, or have the tool add itself to the allowlist. Self-amendment
 * is out on principle: a tool that edits its own access rules is not an access
 * rule. Create-anyway is worse than it looks — it bills for an index every
 * other tool in this connector then refuses, i.e. it succeeds and is useless.
 * So the allowlist applies to create exactly as it applies to a read, and the
 * workflow falls out with no special case: add the intended name on the
 * dashboard FIRST (harmless — an allowlist entry for a name that does not yet
 * exist denies nothing), then create.
 */
export function assertIndexAllowed(
  state: PineconeRulesState,
  indexName: string,
  opts: { intent?: 'read' | 'create' } = {},
): void {
  const denial = denyIndexReason(rulesOf(state), indexName);
  if (!denial) return;

  const fix =
    opts.intent === 'create'
      ? `Add "${indexName}" to the allowed indexes under Access Rules on the dashboard first, then create it — an allowlist entry for a name that does not exist yet denies nothing.`
      : `Edit Access Rules on the dashboard to change it.`;

  const message =
    denial.reason === 'index-blocklist-hit'
      ? `Index "${indexName}" is on this connection's blocked-indexes list (matched "${denial.matched}"). ${fix}`
      : `Index "${indexName}" is not on this connection's allowed-indexes list (${renderPatternList(denial.patterns, 'index')}). ` +
        `${fix} This answer is decided from the rules alone, before any Pinecone call, so it does not tell you whether an index of that name exists.`;

  throw new PineconeAccessDenied(message, {
    reason: denial.reason,
    indexName,
    patterns: denial.patterns,
  });
}

/** Enforce the namespace rules. Fails OPEN when the rules could not be read, as assertIndexAllowed does. */
export function assertNamespaceAllowed(state: PineconeRulesState, indexName: string, namespace: string): void {
  const denial = denyNamespaceReason(rulesOf(state), namespace);
  if (!denial) return;

  const message =
    denial.reason === 'namespace-blocklist-hit'
      ? `Namespace ${describeNamespace(namespace)} is on this connection's blocked-namespaces list. Edit Access Rules on the dashboard to change it.`
      : `Namespace ${describeNamespace(namespace)} is not on this connection's allowed-namespaces list (${renderPatternList(denial.patterns, 'namespace')}). ` +
        `Namespace rules apply across every allowed index, so this is not specific to "${indexName}". Edit Access Rules on the dashboard to change it.`;

  throw new PineconeAccessDenied(message, {
    reason: denial.reason,
    indexName,
    namespace,
    patterns: denial.patterns,
  });
}

/**
 * Gate the two mutating tools. MUST be the first statement of each.
 *
 * Fails CLOSED when the rules could not be read, and the message must not be
 * mistaken for a configured restriction — otherwise the model tells the user
 * "your connection is read-only" when it is a database hiccup.
 */
export function assertWriteAllowed(state: PineconeRulesState, operation: string): void {
  if (state.status === 'unavailable') {
    throw new PineconeAccessDenied(
      `Write refused: this connection's access rules could not be read just now (${state.detail}), so ${operation} cannot confirm whether read-only mode is on. ` +
        `This is a temporary failure, not a configured restriction — retry. Reads are unaffected and continue under whatever rules were last configured.`,
      { reason: 'rules-unavailable' },
    );
  }
  if (state.rules?.readOnly) {
    throw new PineconeAccessDenied(
      `This connection is set to read-only, so ${operation} is refused. Turn off read-only under Access Rules on the dashboard to allow writes.`,
      { reason: 'read-only' },
    );
  }
}

/**
 * Enforce the rules against every target of a cascading search, refusing the
 * whole call if any one of them is denied.
 *
 * All-or-nothing, unlike Slack's listChannels, which drops denied rows and
 * reports the count. The difference is whether the output stays attributable.
 * Slack's output is a list of rows: a dropped row is a row you can count, and
 * a summary line restores the truth. cascading-search's output is a SINGLE
 * FUSED RANKING across the indexes — dropping one source does not remove a
 * section, it silently changes the rank, score distribution and topN cut of
 * everything that remains. There is no honest "this result is partial"
 * annotation for a ranking, because the caller cannot tell which of the
 * returned hits would have been displaced. That is exactly the failure this
 * repo's rule names: a partial result that does not say it is partial reads as
 * complete, and here it CANNOT say it, so it must not be produced.
 *
 * Every denial is collected before throwing — refusing one at a time would
 * cost the caller a round trip per bad entry.
 */
export function assertTargetsAllowed(
  state: PineconeRulesState,
  targets: ReadonlyArray<{ index: string; namespace?: string }>,
): void {
  const rules = rulesOf(state);
  const denied: DeniedTarget[] = [];

  for (const target of targets) {
    const indexDenial = denyIndexReason(rules, target.index);
    if (indexDenial) {
      denied.push({ index: target.index, namespace: target.namespace, reason: indexDenial.reason });
      continue;
    }
    if (target.namespace !== undefined) {
      const nsDenial = denyNamespaceReason(rules, target.namespace);
      if (nsDenial) {
        denied.push({ index: target.index, namespace: target.namespace, reason: nsDenial.reason });
      }
    }
  }

  if (!denied.length) return;

  const lines = denied.map(d => {
    const where = d.namespace === undefined ? `"${d.index}"` : `"${d.index}" / ${describeNamespace(d.namespace)}`;
    return `  - ${where}: ${d.reason.replace(/-/g, ' ')}`;
  });

  throw new PineconeAccessDenied(
    `cascading-search was refused because ${denied.length} of ${targets.length} target(s) are denied by this connection's access rules:\n${lines.join('\n')}\n\n` +
      `The whole call is refused rather than searching the rest: this tool returns one ranking fused across every index, so dropping a source silently changes the ` +
      `order, the scores and the topN cut of everything that remains, and there is no way to label that result as partial. Remove the denied entries, or allow them ` +
      `under Access Rules on the dashboard.`,
    { reason: denied[0].reason, deniedTargets: denied },
  );
}

// ---------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------

export interface FilterResult<T> {
  visible: T[];
  hiddenCount: number;
  /** Emitted only when something really was hidden. */
  note?: string;
}

/**
 * Hide index rows the rules deny, and SAY SO.
 *
 * Hidden rows rather than marked-but-visible ones — the opposite of Slack's
 * listChannels, for a reason specific to this rule set. Slack keeps an
 * org-blocked channel visible and labelled because the user needs to read the
 * ORGANISATION OFF THE ROW to know which box to tick: the row carries
 * information the rule set does not. Here it does not. The rules are a list of
 * index names the user typed themselves, so a visible-but-refused row teaches
 * nothing the summary line does not already say, while giving the model a
 * target it will plan work against and then be refused on.
 *
 * The Slack trap — a filtered-out row reading as "that thing does not exist" —
 * is closed in two places, and BOTH are required. This is the first: the note
 * is unconditional whenever anything was hidden, and states existence outright
 * so the model cannot infer absence. The second is in server.ts, where
 * describe-index answers a hidden name with the DENIAL rather than a 404.
 */
export function filterIndexRows<T extends { name: string }>(
  state: PineconeRulesState,
  rows: readonly T[],
): FilterResult<T> {
  const rules = rulesOf(state);
  if (!hasIndexRules(rules)) return { visible: [...rows], hiddenCount: 0 };

  const visible = rows.filter(row => !denyIndexReason(rules, row.name));
  const hiddenCount = rows.length - visible.length;
  if (!hiddenCount) return { visible, hiddenCount: 0 };

  const allowed = indexPatterns(rules, 'allowedIndexes');
  const blocked = indexPatterns(rules, 'blockedIndexes');
  const detail = [
    allowed.length ? `allowed: ${allowed.join(', ')}` : null,
    blocked.length ? `blocked: ${blocked.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  return {
    visible,
    hiddenCount,
    note:
      `${hiddenCount} of ${rows.length} indexes are hidden by this connection's index rules (${detail}). ` +
      `They exist; this connection cannot use them. Call describe-index with a name to see which rule applies.`,
  };
}

/**
 * Hide denied namespaces from a stats payload, and explain the arithmetic.
 *
 * `totalVectorCount` counts hidden namespaces, so a filtered per-namespace map
 * will not add up to it. Report the total as Pinecone gave it and say why — a
 * number that does not add up and does not explain itself reads as a bug in
 * the tool.
 */
export function filterNamespaceStats<V>(
  state: PineconeRulesState,
  stats: Record<string, V>,
): { visible: Record<string, V>; hiddenCount: number; note?: string } {
  const rules = rulesOf(state);
  if (!hasNamespaceRules(rules)) return { visible: { ...stats }, hiddenCount: 0 };

  const visible: Record<string, V> = {};
  let hiddenCount = 0;
  for (const [ns, value] of Object.entries(stats)) {
    if (denyNamespaceReason(rules, ns)) hiddenCount += 1;
    else visible[ns] = value;
  }
  if (!hiddenCount) return { visible, hiddenCount: 0 };

  return {
    visible,
    hiddenCount,
    note:
      `${hiddenCount} namespace(s) are hidden by this connection's namespace rules, so the per-namespace counts below do not sum to the total. ` +
      `The total is reported exactly as Pinecone gave it and does include the hidden namespaces.`,
  };
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

/** One line describing the rules in force, for a tool response. */
export function describeRules(rules?: PineconeAccessRules): string | undefined {
  const allowedIdx = indexPatterns(rules, 'allowedIndexes');
  const blockedIdx = indexPatterns(rules, 'blockedIndexes');
  const allowedNs = namespacePatterns(rules, 'allowedNamespaces');
  const blockedNs = namespacePatterns(rules, 'blockedNamespaces');
  const readOnly = Boolean(rules?.readOnly);

  const parts: string[] = [];
  if (allowedIdx.length) parts.push(`indexes allowed: ${allowedIdx.join(', ')}`);
  if (blockedIdx.length) parts.push(`indexes blocked: ${blockedIdx.join(', ')}`);
  if (allowedNs.length) parts.push(`namespaces allowed: ${allowedNs.map(describeNamespace).join(', ')}`);
  if (blockedNs.length) parts.push(`namespaces blocked: ${blockedNs.map(describeNamespace).join(', ')}`);
  if (readOnly) parts.push('read-only (create-index-for-model and upsert-records are refused)');
  if (!parts.length) return undefined;

  const namespaceCaveat =
    allowedNs.length || blockedNs.length
      ? ' Namespace rules apply across every allowed index.'
      : '';

  return (
    `Access rules on this connection — ${parts.join('; ')}.${namespaceCaveat} ` +
    `These bind every tool in this connector; they do not limit the API key itself.`
  );
}
