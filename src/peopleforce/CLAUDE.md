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

### Salaries, holidays, absences (v3; NOT exercised live)
- **Salary reads are gated by an operator allowlist** (`mayViewCompensation` in `src/auth/compensationAccess.ts`) — the Company key belongs to the connection owner but other users ask through it, so the key's own restriction alone would expose pay to everyone. Covers `listEmployeeSalaries`, v4 `listPersonSalaries`/`getPersonSalary` and the REST salaries route; refused before any upstream call.
- **Allowlist = `PEOPLEFORCE_COMPENSATION_EMAILS` ∪ `ADMIN_EMAILS`** (comma-separated, case-insensitive). Unset ⇒ admins only (fail closed). Read from the environment on every call; changing it needs a restart. Set BOTH variables on the web, peopleforce and peopleforce-v4 services — each process reads its own env, so a service without `ADMIN_EMAILS` refuses admins too.
- **Two distinct 403s (v3)** — not on the allowlist: `COMPENSATION_RESTRICTED_MESSAGE` / REST `compensation_restricted`; allowlisted but upstream answers 403 (normally the key lacks People → Compensation; the cause is not checked): its own message / REST `compensation_forbidden_by_key`. Never reuse the generic "check your key" text. v4 salary tools keep the generic v4 role-403 message.
- **Current salary is marked per compensation component** (`markCurrentSalaries`): newest first (effective_on desc, undated last, ties by id desc); groups are per component (by id, else by name; component-less records form one group) and `current` = the group's newest record with effective_on <= today. Future-dated is never current ("(scheduled)"). After the heading, the text has one summary line per group with a dated record — `Current[ (name)]: ...` with the previous dated rate, or `No current rate[ (name)]: next ...` (the earliest future date, highest id on that date — the record that will become current); undated-only groups get none. Today is the UTC date, so for a UTC+N tenant a raise effective today reads as scheduled for up to N hours.
- **Residual ungated surfaces** — tenant custom fields and custom tables (e.g. an Invoice sheet link, `getEmployeeTable`) and their snapshot copies (`pf_employee_custom_field_snapshot`, `pf_employee_table_cell_snapshot`) can hold pay data and are not gated. Recruitment candidates' salary expectation (`getCandidate`, `getCandidateDossier` and their REST routes) is deliberately ungated: it is not employee compensation.
- **`getEmployeeAbsences` = approved (optionally pending) leave + the employee's holidays**, overlap-checked here, 10 pages per source then `truncated`. v2 ignored `employee_id` on /leave_requests; v3 documents it, but rows for anyone else are still dropped (`mine`).
- **Holidays: the day off can be `observed_on` or `compensated_on`**, not the date itself — both count for overlap. `working: true` is a worked day, listed apart, never as an absence.

### REST plane
- **46 GETs + 4 POSTs** (`createLeaveRequest`, `addCandidateNote`, `moveVacancyApplication`, `disqualifyVacancyApplication`) under `/api/v1/peopleforce/*`. **The permanent dashboard API key can mutate leave and recruitment state.**
- **Validate with the tools' schemas** (`createLeaveRequestSchema`, `moveVacancyApplicationSchema`, `disqualifyVacancyApplicationSchema`, `addCandidateNoteSchema`) via `safeParse` → 400; never hand-roll checks.
- **Path params override body keys.** Move/disqualify re-read the application.
- **`disqualifyVacancyApplication` is not idempotent.**
- **The salaries route is not a raw passthrough** — `data[]` is re-sorted newest first and each record gains `current`; other top-level keys are kept. Gated by the allowlist above.
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
