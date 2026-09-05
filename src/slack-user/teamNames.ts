// src/slack-user/teamNames.ts
// Best-effort team-ID → display-name resolution, shared by org discovery (which
// labels the dashboard's Organizations checkboxes) and by access-denied errors
// (which name the org that blocked a read).
//
// It lives in its own module rather than in accessControl.ts or
// slack/apiHelpers.ts on purpose: orgDiscovery must not import the enforcement
// engine (that inverts the dependency its module header describes), and
// apiHelpers.ts is the stateless transport layer shared with slack-bot — a
// stateful TTL cache does not belong there.

/**
 * The slice of SlackClient this needs. Structural so both servers and the
 * dashboard can pass their own client, and tests a stub.
 */
export interface TeamNameClient {
  /** Only `name` is read — kept minimal so any caller's client shape fits. */
  teamInfo(teamId?: string): Promise<{ team: { name?: string } }>;
}

export interface TeamNameResult {
  names: Map<string, string>;
  /** True when `max` cut the lookup short — the caller must say so. */
  truncated: boolean;
  /** Ready-made note for the caller's `notes` array, when truncated. */
  note?: string;
}

/**
 * Positive results effectively never change. Negative ones are also durable —
 * `team.info` on a foreign org fails by design, not transiently — but they get
 * a shorter TTL so a genuine permission change is picked up the same session
 * rather than being wrong for half an hour.
 */
const POSITIVE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

const teamNameCache = new Map<string, { name: string | null; expiresAt: number }>();

/** Bound the cache the same way the meta cache is bounded. */
const TEAM_NAME_CACHE_MAX = 500;

export function clearTeamNameCache(): void {
  teamNameCache.clear();
}

function pruneTeamNameCache(now: number): void {
  for (const [key, entry] of teamNameCache) {
    if (entry.expiresAt <= now) teamNameCache.delete(key);
  }
  // Still oversized after dropping expired entries — evict oldest-inserted.
  // Map preserves insertion order, so the first keys are the stalest.
  if (teamNameCache.size > TEAM_NAME_CACHE_MAX) {
    const excess = teamNameCache.size - TEAM_NAME_CACHE_MAX;
    let dropped = 0;
    for (const key of teamNameCache.keys()) {
      teamNameCache.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Resolve display names for `teamIds`, best-effort.
 *
 * `team.info` on a *foreign* team usually fails even with `team:read`, and by
 * construction every org in an access denial is foreign — so a miss is the
 * normal case, not an error. Callers must fall back to the raw `T0…` ID, which
 * is also how the dashboard labels an org with `nameResolved: false`, making
 * the ID the reliable half of the answer.
 *
 * Never throws: this decorates messages, and an exception here would replace a
 * precise denial with a generic one.
 *
 * `tokenKey` scopes the cache. **Omit it to bypass the cache entirely** — a
 * bare team-ID key would serve one workspace's names to another, since whether
 * `team.info` succeeds depends on the calling token, not the team.
 */
/**
 * Split the requested IDs into names already cached and IDs still to look up.
 * Without a `tokenKey` nothing is cached, so everything is pending.
 */
function partitionCached(
  teamIds: string[],
  tokenKey: string | undefined,
  now: number,
): { cached: Map<string, string>; pending: string[] } {
  const cached = new Map<string, string>();
  const pending: string[] = [];
  for (const id of new Set(teamIds.filter(Boolean))) {
    const hit = tokenKey ? teamNameCache.get(`${tokenKey}:${id}`) : undefined;
    if (hit && hit.expiresAt > now) {
      if (hit.name) cached.set(id, hit.name);
    } else {
      pending.push(id);
    }
  }
  return { cached, pending };
}

/** One best-effort `team.info`. Never throws; caches the failure too. */
async function lookupOne(
  client: TeamNameClient,
  id: string,
  tokenKey: string | undefined,
): Promise<string | null> {
  let name: string | null = null;
  try {
    const { team } = await client.teamInfo(id);
    if (team?.name) name = team.name;
  } catch { /* foreign org — the ID is the fallback label */ }
  if (tokenKey) {
    teamNameCache.set(`${tokenKey}:${id}`, {
      name,
      expiresAt: Date.now() + (name ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
  }
  return name;
}

export async function resolveTeamNames(
  client: TeamNameClient,
  teamIds: string[],
  options?: { tokenKey?: string; max?: number },
): Promise<TeamNameResult> {
  const max = options?.max ?? 40;
  const tokenKey = options?.tokenKey;
  const { cached, pending } = partitionCached(teamIds, tokenKey, Date.now());

  const names = new Map(cached);
  // Sequential: team.info is rate-limited and this runs while a user waits.
  for (const id of pending.slice(0, max)) {
    const name = await lookupOne(client, id, tokenKey);
    if (name) names.set(id, name);
  }
  if (tokenKey) pruneTeamNameCache(Date.now());

  const truncated = pending.length > max;
  return {
    names,
    truncated,
    note: truncated
      ? `Only the first ${max} organisations were named; the rest are shown by ID.`
      : undefined,
  };
}

/**
 * Render a team ID for a human: `Acme Corp (T0123)` when Slack named it, plain
 * `T0123` when it did not.
 *
 * The ID is never dropped even when a name is known — it is what the
 * dashboard's Organizations checkbox is labelled with for unresolved orgs, so
 * it is the only thing that reliably lets a user match an error to the row they
 * have to tick.
 */
export function formatTeamLabel(teamId: string, names?: Map<string, string>): string {
  const name = names?.get(teamId);
  return name ? `${name} (${teamId})` : teamId;
}
