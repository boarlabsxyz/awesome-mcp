// src/peopleforce/snapshot/resolve.ts
// Pure owner→employee resolution. Objective/KPI owners often arrive name-only
// (no stable id), so joining rollups to teams by matching name strings each run
// is fragile. This resolves each distinct owner to an employee_id once and lets
// the caller persist the mapping; a manual-override row is never re-resolved.
//
// No fuzzy/Levenshtein matching: it's normalized-exact on email then name.
// Approximate name matching risks wrong joins (two "Kate"s), so unresolved
// owners are surfaced for one-time manual reconciliation (the manual_override
// column) rather than auto-guessed.

export interface ResolverEmployee {
  employee_id: string;
  full_name?: string | null;
  email?: string | null;
}

export interface OwnerInput {
  employee_id?: string | null;
  email?: string | null;
  name?: string | null;
}

export type ResolutionMethod = 'id' | 'email' | 'name' | 'unresolved';

export interface OwnerResolution {
  owner_key: string;
  owner_email: string | null;
  owner_name: string | null;
  employee_id: string | null;
  method: ResolutionMethod;
  confidence: number;
}

/** Lowercase, strip punctuation, collapse whitespace — for case/format-insensitive name matching. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable identity for an owner: prefer email, else normalized name. Empty → null. */
export function ownerKey(owner: OwnerInput): string | null {
  const email = owner.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const name = owner.name ? normalizeName(owner.name) : '';
  if (name) return `name:${name}`;
  return null;
}

/**
 * Resolve distinct owners against the employee dimension. `existing` maps
 * owner_key → whether that key is a manual override; manual keys are returned
 * unchanged (never re-resolved). Returns one resolution per distinct owner plus
 * the unresolved subset for alerting/manual reconciliation.
 */
export function resolveOwners(
  owners: OwnerInput[],
  employees: ResolverEmployee[],
  existingManualKeys: ReadonlySet<string> = new Set(),
): { resolutions: OwnerResolution[]; unmatched: OwnerResolution[] } {
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const e of employees) {
    ids.add(e.employee_id);
    const email = e.email?.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, e.employee_id);
    const name = e.full_name ? normalizeName(e.full_name) : '';
    if (name) {
      const arr = byName.get(name) ?? [];
      arr.push(e.employee_id);
      byName.set(name, arr);
    }
  }

  const seen = new Set<string>();
  const resolutions: OwnerResolution[] = [];
  const unmatched: OwnerResolution[] = [];

  for (const owner of owners) {
    const key = ownerKey(owner);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (existingManualKeys.has(key)) continue; // preserve human reconciliation

    const email = owner.email?.trim().toLowerCase() ?? null;
    const name = owner.name?.trim() || null;
    let employee_id: string | null = null;
    let method: ResolutionMethod = 'unresolved';
    let confidence = 0;

    if (owner.employee_id && ids.has(String(owner.employee_id))) {
      employee_id = String(owner.employee_id);
      method = 'id';
      confidence = 1;
    } else if (email && byEmail.has(email)) {
      employee_id = byEmail.get(email)!;
      method = 'email';
      confidence = 1;
    } else if (name) {
      const matches = byName.get(normalizeName(name));
      // Only accept a unique normalized-name match — ambiguous names stay unresolved.
      if (matches && matches.length === 1) {
        employee_id = matches[0];
        method = 'name';
        confidence = 0.7;
      }
    }

    const res: OwnerResolution = { owner_key: key, owner_email: email, owner_name: name, employee_id, method, confidence };
    resolutions.push(res);
    if (method === 'unresolved') unmatched.push(res);
  }

  return { resolutions, unmatched };
}
