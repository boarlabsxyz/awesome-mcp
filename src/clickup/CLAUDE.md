# ClickUp — notes for Claude

## Rules and limitations

### Docs and Doc images

- **Docs search is client-side** — `GET /api/v3/workspaces/{id}/docs` has no text-search or sort param (`limit` 10–100, default 50; opaque `cursor`/`next_cursor`). `listDocs` is the unfiltered call; matching/paging/ordering live once in `ClickUpClient` (`matchesDocQuery`, `sortDocsNewestFirst`, `searchAllDocs`) for MCP and REST — never add a per-caller filter.
- **`searchDocs` auto-pages and always reports scan extent** — cap `DOCS_MAX_PAGES = 20` (2000 docs), newest-first; a bare "No docs found" reads as "doesn't exist". `request()` has no 429 backoff, so a mid-scan limit returns partial results flagged `rateLimited`.
- **Title match is token-AND, not substring** — every word, any order (`"AWESOME Sync"` matches `[AWESOME] Sync - 08/15/2026`).
- **`parentType: 'EVERYTHING'` is dropped** — ClickUp accepts it but matches nothing. `SPACE`/`FOLDER`/`LIST` require `parentId` (Zod). `createDoc.parentType` (numeric 4/5/6) is a different param — don't unify.
- **Doc images are self-hosted** — no Doc image-upload API (SPA `/v1/attachment` needs a browser JWT). `insertImageIntoPage`/`uploadClickUpDocImage` fetch a public URL (SSRF-guarded per redirect hop in `fetchImageBytes`, 20 MB cap), store in Postgres (`clickup_doc_images`, `docImageStore.ts`), embed `![](BASE_URL/images/clickup-doc/<id>)` via `editPage`. Serve route `registerClickUpDocImageRoutes` is public (UUID ids). Needs `DATABASE_URL` + `BASE_URL`; URL input only.
- **Never store Doc images `ephemeral`** — ClickUp re-fetches on every view; an expiring blob 404s later.

### Comments

- **`GET /task/{task_id}/comment` returns the 25 newest, no total/cursor** — page with `start` (oldest comment's `date`) + `start_id` (its `id`) until < 25. `ClickUpClient.getAllTaskComments` serves MCP and REST; cursor verified live.
- **Only a short page sets `complete`** — other stops are named (`hitLimit`, `hitCap`, `stalled`, `rateLimited`, `cursorUnavailable`) with a resume cursor. Exactly 25 comments costs a 2nd request and is not `hitCap`; a `limit` ending a short page is `complete`. A failed scan's empty result never renders as "No comments on this task."
- **Dedupe by id; keep `stalled`** — a full page adding nothing is reported, not looped (an ignored cursor would return duplicates).
- **Cursor halves validated in `execute`, not Zod** — Zod gives generic `InvalidParams`; ClickUp ignores a lone half and returns the newest 25.
- **REST `GET /api/v1/clickup/tasks/{taskId}/comments` pages fully by default** — `?allPages=false`, `?limit=N`, `?start=&start_id=` (`startId` alias, refused if they disagree); keeps `comments` shape, adds `scan`; refuses `page`/`cursor` by name.
- **Newest-first, labelled; `oldestFirst` reverses** — flipping the default would silently change the contract.
- **Threaded replies are a ceiling** — `GET /comment/{id}/reply` has no paging, so not exposed; `formatComment` prints `[N threaded replies, not included]`.

### Task types, parents, multiple lists

- **Task type is a bare number** — `taskTypeId` → `custom_item_id`; `0` Task (also resets), `1` Milestone. `GET /team/{id}/custom_item` omits both, so `listTaskTypes` prepends them. `formatTask` shows `Task type:` only when non-zero, as a number (no name in payload). Type determines which custom fields are returned.
- **Re-parent via `updateTask.parentTaskId`** — `.nullable()`, not `.min(1)`, so null/`''`/self-reference get a clear message, not `InvalidParams`. ClickUp can't clear a parent, so null is refused.
- **Keep a plain update to one call with unchanged output** — only a re-parent pays the pre-flight `getTask(parent)` (a hard gate: nothing is written yet, and it is the only source of the parent's name) and the post-write re-read (best-effort: a mismatch reports `⚠ Re-parent did NOT take effect`, since a stale PUT echo would read as success).
- **Re-parent standalone** — the PUT is atomic, so a rejected parent drops the other fields too. The local cycle check sees only the immediate parent and root; deeper cycles rely on ClickUp's rejection. Cross-list parents are UNVERIFIED, so report both lists rather than assert a rule.
- **No webhook event for parent changes** (`taskMoved` = list move) — don't synthesise history rows (would miss UI moves; `ClickUpTaskEvent` needs `subscriptionId`).
- **`formatTask` owns `Parent:`/`Top-level parent:`/`Also in lists:`** for all five task tools and REST `text/plain` — `Top-level parent` hidden when it repeats `parent`/own id; `Also in lists` subtracts `task.list` from `locations`.
- **Legacy `PATCH /api/v1/clickup/tasks/:taskId` forwards `parent` raw on purpose** — guards are LLM message quality, not integrity.
- **Tasks in Multiple Lists: a disabled ClickApp answers 401**, same as a revoked token or bad ID (`OAUTH_027`). `addTaskToList`/`removeTaskFromList` pre-flight `getTask` + `getList`; only a 401 after both is blamed on the ClickApp (also naming "Subtasks in Multiple Lists"). Those reads supply the names (writes return 200 empty).
- **Multi-list verdict is four-way** — re-read failed → requested state; no `locations` key → unconfirmed; disagreeing → `⚠ did NOT take effect`. Missing `locations` is not absence, so no-op shortcuts fall through to the API. Refused locally: removing from home list, adding to home list (200 no-op).
- **`encodeURIComponent` every ID in a path** — `?`/`#` would truncate it.
- **Only an answered 4xx means "not changed"** — `request()` tags answered + status (`clickUpErrorStatus`); 5xx/timeouts are "outcome UNKNOWN". Custom task IDs unsupported.
- **REST multi-list writes skip the pre-flight** (`POST /api/v1/clickup/tasks/{taskId}/lists/{listId}`, `.../remove`) — so a REST 401 is never blamed on the ClickApp; they keep the re-read (`confirmed` three-valued).
- **Shared tasks are hidden by list unless `include_timl=true` (verified live)** — `listTasks` sends it by default (`includeMultiListTasks=false` opts out, REST too), read as `!== false` so a bypassed schema still defaults ON. `sharedTaskNote` explains foreign home lists.
- **`GET /team/{team_id}/task` has no `include_timl`** — `filterTeamTasks`/`searchTasks` `list_ids` = home list only. Don't add it: ClickUp ignores unknown keys.

### Dates

- **Clear a due date with `clearDueDate: true`** — `toClickUpTimestamp` must keep refusing unparseable input (NaN → JSON `null` → ClickUp clears and answers 200). Not `.nullable()`: an accidental null would wipe data. `clearDueDate: true` with `dueDate` → refused, nothing written; `clearDueDate: false` is a no-op, so `dueDate` still applies. Lives once in `resolveDueDateUpdate` (`restWrites.ts`; the MCP tool builds its body inline).
- **Clears are verified** — trust an agreeing PUT echo; a disagreeing one buys a `getTask`. REST `dueDateCleared` is true/false/null(unconfirmed). `due_date: null` UNVERIFIED end-to-end (`priority: null` verified). `start_date` has the same gap, left alone.
- **Every date sends its `*_date_time` boolean (verified live)** — omitted = false = ClickUp keeps the workspace-LOCAL date at 04:00, so a late-UTC instant shifts a day. `inputCarriesTimeOfDay`: ISO with `HH:MM` → true, `YYYY-MM-DD` → false, Unix ms → true; `toClickUpDateValue` returns `{ ts, hasTime }`; flags independent; a clear sends none. Used by `createTask`, `updateTask`, `buildTaskUpdateBody`, `updateList`, `performUpdateList`; not `getTimeEntries` filters or native passthrough routes.
- **Known gap:** date-only = UTC midnight, so negative-offset workspaces get the previous local day (no workspace TZ here).

### Custom fields

- **Field DEFINITIONS can't be created/edited (API ceiling)** — only reads (`GET /list|space|folder|team/{id}/field`) and per-task value set/remove. Never add a create-field tool; the ceiling is in the `getAccessibleCustomFields`/`removeCustomFieldValue` descriptions. Re-check: `curl -s https://developer.clickup.com/llms.txt | grep -i field` (raw). Values verified live: `drop_down`, `number`, `labels`, `url`.
- **`setCustomFieldValue.value` is a typed union, not `z.any()`** — `z.any()` emits `{}`, so clients stringified arrays (`FIELD_144`). `customFieldValue.ts` revives them for `labels`, `users`, `tasks`, `list_relationship` (`attachment` unverified, excluded).
- **Revival is type-dependent** — `["a"]` is a valid `text` literal, so the definition is looked up (`getTask` → list → `getAccessibleCustomFields`) only when `needsFieldLookup`. Best-effort: on failure only JSON array/object strings are revived (`"12"` stays a string), noted in the response.
- **Unknown label/drop-down options are refused before writing**, listing valid ones.
- **Drop-down forms** — UUID passes through; number/numeric string = orderindex (verified); only a name resolves to UUID. A numeric string is never a name (options `1..10` have orderindex `0..9`) — collisions reported with the UUID; nonexistent orderindex refused.
- **`users`/relationship `{add, rem}` objects pass through untouched** — never array-wrap; other objects refused.
- **No post-write re-read** — 200 empty body, and type-scoped fields are absent from task payloads.
- **Task payloads omit fields not applicable to the task TYPE (verified live)** — `applied_objects[].object_id` = task-type IDs. Omitted ≠ empty; `searchTasks` `custom_fields` filters still match. `getAccessibleCustomFields` renders `Applies to task types:` (`all` if absent) plus a note; `getTask`'s description warns too.

### REST plane

- **Two write-body contracts on purpose** — legacy routes take ClickUp-NATIVE snake_case (`due_date`, `custom_item_id`, `comment_text`, `tid`, `parent`) verbatim, as published in `public/openapi-clickup.json`; validating them with tool schemas would 400 every generated client. CamelCase lives on separate action paths (`POST /tasks/{id}/update`, `/lists/{id}/update`, `/tasks/{id}/delete`) validated by `restWrites.ts`. One path = one body shape.
- **Anti-drift = shared field objects** (`taskUpdateFields`, … in `restWrites.ts`) spread by both surfaces; REST adds `.refine()` (empty body = silent no-op). `src/__tests__/restWriteSchemaSharing.test.ts` guards re-inlined fields and lost `.describe()`. Routes register from a table + one generic handler.
- **The permanent dashboard API key can delete** — `DELETE /tasks/{id}`, `/lists/{id}`, `/tasks/{id}/fields/{fieldId}`. Not exposed: `subscribeToTaskEvents`/`unsubscribeFromTaskEvents` (mint webhook secrets). No filesystem-path params, ever.
- **`POST /api/v1/clickup/spaces/{spaceId}` takes the WORKSPACE id** — published misnomer, kept.
- **Upstream status sits on a SYMBOL (`CLICKUP_STATUS`)** — `sendUpstreamError` can't see it, so 404 → 500 (or 400 via `UserError`). New routes copy it to `.code`; the ~24 older GETs still don't — known defect, fix all at once in a shared helper.
- **Unset `IMAGE_PUBLIC_BASE_URL` → `ServiceNotConfiguredError` → 503.**

## Source Files

| File | Contains |
|------|----------|
| `src/clickup/restWrites.ts` | Each write's camelCase fields (`taskUpdateFields`, …) + op, shared by `server.ts` and `webServer.ts`; documents the native-vs-camelCase split |
| `src/clickup/docImageIngest.ts` | The one Doc image-ingest path (base64, guarded fetch, store, already-hosted check), shared by MCP and REST |
