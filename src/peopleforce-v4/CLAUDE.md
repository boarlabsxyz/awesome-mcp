# PeopleForce v4 — notes for Claude

## Rules and limitations

- **A second connector, not an upgrade** — Company keys work on v1–v3, Career keys on vacancies, Service-account keys only on `/api/v4/*`, and v4 rejects the others. So `peopleForceV4AccessToken` is a separate session field and `getPeopleForceV4Client` must not fall back to `peopleForceAccessToken`.
- **Different set, not a superset** — no recruitment, leave, KB, skills, competencies, KPIs or custom tables (still v2/v3); adds termination dates/reasons, terminated/birthday/anniversary feeds, salaries, lifecycle, reviews, Pulse, compliance.
- **Renamed resources and pagination** — `/api/v4/people` (`/employees` 404s, verified live); `pages`→`total_pages`, `count`→`total_count`, `items`→`per_page` (now the requested size, not the page's row count). Old names read as `undefined`, i.e. a silently missing total.
- **Out-of-population records are omitted from a 200** — counts are floors, empty lists get the role-population note, and a 404 means "does not exist OR outside this role's population".
- **Ungranted fields are absent, not null** — `formatPerson` diffs against the documented field list with `in` and names what was withheld; never render a blank.
- **Writes are additive** — create/update people and org structure only; delete/terminate/activate are not exposed (irreversible). Department/position/job level/location/work type/manager aren't writable in v4, so `personBody` drops them.
- No per-vacancy API restriction in v4 either.
- **Hidden unless `PEOPLEFORCE_V4_ENABLED=true`** (strict `=== 'true'`) — seeded every boot with `isActive` set from that flag (default `false`), filtered by both catalog backends; flipping it is a restart. Seeded, not skipped, so existing connections aren't orphaned (hidden, Copy URL yields `''`); `mcp:peopleforce-v4` stays in `scopeMap.ts`, so they keep working.

## Source Files

| File | Contains |
|------|----------|
| `src/peopleforce-v4/server.ts` | v4 tool definitions (service-account key; `PEOPLEFORCE_V4_BASE_URL`, default app.peopleforce.io/api/v4) |
| `src/peopleforce-v4/apiHelpers.ts` | `PeopleForceV4Client` (X-API-KEY) and the formatters that surface role-omitted rows/fields |
