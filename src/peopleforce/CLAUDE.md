# PeopleForce (v2/v3) — notes for Claude

## Rules and limitations

### Keys
- **Service-account keys are rejected on purpose** — they work only on `/api/v4` and belong to `peopleforce-v4`. They 401 on `validatePeopleForceToken` like a revoked key, so the rejection message names the key type.

### Employees, probation, `status` (verified live)
- **`probation_ends_on` is HR-set** — report it, never derive from `hired_on`; spans vary and are extendable. `probationStatus()` derives `Probation:` in `formatEmployee`/`formatEmployeeList`; a null date is `unknown`, never "passed".
- **"Failed probation" is not computable** — no probation-status field and no termination date in v2/v3. `probation_failed` in `PROBATION_STATUS_VALUES` is reserved, never emitted.
- **`status` is an allowlist (`EMPLOYEE_STATUS_VALUES`: `active`, `probation`, `inactive`)** — `on_probation` is silently ignored upstream (fails open); `terminated` returns a mixed active+inactive set. Omitting `status` = active only; headcount = active + inactive.
- **`status=probation` is still paginated** — follow `metadata.pagination`.

### Custom tables (v3)
- `listEmployeeTables` gives definitions and `internal_name`; `getEmployeeTable(employeeId, internalName)` gives rows.
- **`internal_name` is a system slug unrelated to the display name** — always look it up, never guess.
- **The row GET is wrapped in `{ data: {...} }`** (undocumented) — unwrap, or every table reads empty.
- **`formatEmployeeTable` dumps the raw payload when no `rows` array** — never report a silent 0.

### L&D ceiling (verified live)
- **No courses, enrollments, participation, completions or L&D cost/hours entities** — they appear only as objective/KR text (or a tenant's custom table).
- **Skills have no timestamps** (skills-over-time needs snapshots); **objectives/KPIs have no date filter** (`page` only — filter `Period` client-side); no bulk employee-skills endpoint (one call per employee).
- **Custom fields are tenant-dependent** — never name specific fields in tool descriptions.
- `formatObjectiveList`/`formatKpiList` surface owner `id`+`email`; KB `body` may be an object (`formatKnowledgeArticle`); `formatCustomFields` strips HTML.

### REST plane
- **41 GETs + 4 POSTs** (`createLeaveRequest`, `addCandidateNote`, `moveVacancyApplication`, `disqualifyVacancyApplication`) under `/api/v1/peopleforce/*`. **The permanent dashboard API key can mutate leave and recruitment state.**
- **Validate with the tools' schemas** (`createLeaveRequestSchema`, `moveVacancyApplicationSchema`, `disqualifyVacancyApplicationSchema`, `addCandidateNoteSchema`) via `safeParse` → 400; never hand-roll checks.
- **Path params override body keys.** Move/disqualify re-read the application.
- **`disqualifyVacancyApplication` is not idempotent.**
- **Every route resolves its token via `peopleForceToken()`** (403 if not connected) — else a Google session sends an undefined bearer. `peopleForceBaseUrl` is optional.

### Trends → snapshot collector
- No history in the API, so trends come from `src/peopleforce/snapshot/` (`npm run snapshot:peopleforce`) into append-only `pf_*_snapshot` tables with `captured_at`; forward-only, single-tenant, needs `PEOPLEFORCE_API_KEY` + `DATABASE_URL`.
- Custom-table cells go to `pf_employee_table_cell_snapshot` (multi-select one row per value); scope with `PEOPLEFORCE_SNAPSHOT_TABLES` (comma-separated `internal_name`s), else all tables (`employees × tables` calls).

## Source Files

| File | Contains |
|------|----------|
| `src/peopleforce/server.ts` | Tool definitions and exported write schemas (`PEOPLEFORCE_BASE_URL`, default app.peopleforce.io/api/public/v2) |
| `src/peopleforce/apiHelpers.ts` | `PeopleForceClient` — API-key/Bearer client |
| `src/peopleforce/snapshot/` | Snapshot collector; also `pf_employee_dim`, `pf_owner_resolution` (`resolve.ts`), `pf_kb_article_snapshot`, LLM objective classifier (`classify.ts`, `npm run classify:peopleforce-objectives`). See its `README.md`. |
