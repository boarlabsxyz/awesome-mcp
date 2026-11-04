# Storage MCP — notes for Claude

Collections with enforced schemas, kept in this platform's own Postgres, so Claude can store structured data between conversations (e.g. a cache of researched LinkedIn profiles). No upstream provider and no credential. The ops have run end to end against a local Postgres 15 (DDL, upsert's `(xmax = 0)` created/updated split, transactional migrations and their rollback, key rebuilds, cascades). UNVERIFIED through a deployed MCP client: the Railway service, `/connect/storage`, and Claude actually following the tool descriptions.

## Rules and limitations

- **Data is per user, keyed by the CALLER's `session.userId`.** `resolveSession` answers `storage` before the instanceId path (which skips ownership) and before the Google-token fallback; a storage instance id replayed against another server answers 400. The session keeps an instance id only when it is the caller's own Storage connector — it labels usage analytics, and a caller must not file calls under someone else's.
- **One connector per user**, since every connector reaches the same data: `connect.ts` checks, and the partial unique index `idx_mcp_connections_one_storage` closes the race between two overlapping connects (the loser answers `exists`). Connect refuses with 503 without a database — the file-backed connection store would otherwise accept a connector no tool can serve.
- **Every write holds the user's write lock** (`withUserWriteLock`: a transaction plus `pg_advisory_xact_lock`), taken BEFORE the schema read. Without it, two inserts pass the same quota totals, a write validates against a schema a concurrent migration is replacing, and concurrent updates lose each other's fields. Verified against real Postgres with parallel calls. Reads take no lock; users never wait on each other.
- **Field names that are `Object.prototype` members (`constructor`, `toString`, …) are reserved.** Zod reads a missing key's inherited value, so such a field would fail validation on every record. Look fields up with `fieldOf` (own-property), never `fields[name]`.
- **An empty `keyField` value is refused** on insert and update: it would be stored as a NULL key, which `UNIQUE` never compares equal, so duplicates slip in and the record cannot be found by key.
- **The schema is strict; it changes only through `migrateCollection`.** Unknown fields are rejected. That constraint is the product — the hypothesis is that forcing Claude to declare and migrate a schema makes it think about the data — so do not add a "loose" write path.
- **A migration must say what happens to existing records.** A required field added to a non-empty collection needs a `default`; a type change converts every value (`convertValue`, a fixed table that refuses rather than guesses) or aborts. `planMigration` is pure and runs identically for the dry run and the apply, so the dry run shows exactly what will be written. Applying is one transaction with the collection row locked `FOR UPDATE`; any record that cannot migrate aborts the whole migration.
- **Compare records with `canonicalJson`, never `JSON.stringify`.** Postgres hands JSONB back with keys reordered, so a plain string comparison counts every untouched record as changed.
- **A migration keeps each record's `updated_at`.** Freshness (`_ageDays`, `_stale` against `ttlDays`) is measured from it, and reshaping data does not refresh it.
- **Field names reach SQL only as bound parameters** (`data ->> $3`), never spliced into the text — `buildFindSql` is tested with an injection string.
- **`_stale` compares the unrounded age** with `ttlDays`; `_ageDays` is only the display value (one decimal).
- **Quotas, read per call** — a migration that grows records is held to the user byte total too, in the dry run and the apply: `STORAGE_MAX_COLLECTIONS` (50/user), `STORAGE_MAX_RECORDS` (10,000/collection), `STORAGE_MAX_RECORD_BYTES` (64 KB), `STORAGE_MAX_USER_BYTES` (50 MB/user). The connector is visible to everyone, and this is our database.
- **Writes are all or nothing and never silent.** One invalid record rejects the batch with per-index issues; `updateRecord`/`deleteRecords` report not-found instead of succeeding; `findRecords` always returns `total` and `nextCursor`.
- **Argument names keep stored data out of analytics.** The collection is `collection` and free text is `contains`, neither in `PREVIEW_KEYS` (`src/usage/argSummary.ts`) — `name`/`query` would record their values.
- **No database is an error, never an empty answer.**
- **Deferred:** semantic/vector search, computed (JSONata) and script backfills (they wait for the sandbox), and the REST routes — catalog entries are `planned`; wire them with `/add-rest-endpoint storage`. Not wired in the combined web+MCP mode.

## Deployment

A Railway service like the other connectors: `TRANSPORT=httpStream`, `MCP_MODE=mcp`, `MCP_SLUG=storage`, `DATABASE_URL`, `REDIS_URL`; set `STORAGE_MCP_URL` on the web service. Tables are created at boot by `initDatabase()` (`src/db.ts`).

## Source Files

| File | Contains |
|------|----------|
| `src/storage/server.ts` | Tool registrations |
| `src/storage/schemas.ts` | Tool parameter schemas, shared with the future REST routes |
| `src/storage/fieldSchema.ts` | The field language → strict Zod, record validation, type conversions |
| `src/storage/migrations.ts` | `planMigration` — the pure migration planner |
| `src/storage/ops.ts` | Tool bodies: quotas, cross-argument checks, presentation of records |
| `src/storage/store.ts` | All DML, `withUserWriteLock` / `withTransaction`, `buildFindSql` |
| `src/storage/connect.ts` | One-click connector creation for `/connect/storage` |
