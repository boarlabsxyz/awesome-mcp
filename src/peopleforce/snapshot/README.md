# PeopleForce L&D snapshot collector

The PeopleForce public API exposes **no history and no date-range filtering**, so
trend dashboards ("skills over time", "L&D activity this quarter", "participation
trends") are impossible from the API alone. This collector periodically captures
the **current** state stamped with `captured_at`; querying across stamps
reconstructs the trend the API won't give you.

> **Start collecting now.** History cannot be backfilled — every day without a
> snapshot is a day of trend data you can never recover.

```
PeopleForce API ──(nightly)──▶ collect.ts ──▶ Postgres (pf_*_snapshot) ──▶ Grafana
```

## What it captures

| Table | Source | Powers |
|-------|--------|--------|
| `pf_employee_snapshot` | `listEmployees` | roster / team joins over time |
| `pf_employee_skill_snapshot` | `listEmployeeSkills` (per employee) | skills portfolio over time |
| `pf_employee_custom_field_snapshot` | employee custom fields | Dev Sprint / courses / L&D spend (when a tenant records them) |
| `pf_objective_snapshot` | `listObjectives` | development activities, dev sprints & courses (as OKR prose) |
| `pf_kpi_snapshot` | `listKeyPerformanceIndicators` | performance KPIs |
| `pf_kb_article_snapshot` | `listKnowledgeBaseArticles` | L&D content authored per quarter (articles carry `created_at`) |
| `pf_employee_dim` | `listEmployees` (upserted, current-state) | team dimension for owner joins |
| `pf_owner_resolution` | derived | objective/KPI owner → employee mapping (with `manual_override`) |
| `pf_objective_classification` | LLM (separate step) | is-learning / activity_type / provider / completion / confidence |
| `pf_snapshot_run` | — | run log (status + per-table counts) |

### Owner resolution (Feature B)

Objective/KPI owners often arrive name-only. The collector maintains `pf_employee_dim` (current-state) and resolves each distinct owner to an `employee_id` in `pf_owner_resolution` — by email, then unique normalized name. Ambiguous or unknown owners land as `method = 'unresolved'`; reconcile those **once by hand** and set `manual_override = TRUE` so the collector never overwrites them:

```sql
-- The unresolved tail to reconcile (usually a handful of rows)
SELECT owner_key, owner_name, owner_email FROM pf_owner_resolution WHERE method = 'unresolved';
-- Fix one and pin it:
UPDATE pf_owner_resolution SET employee_id = '12345', method = 'manual', manual_override = TRUE
WHERE owner_key = 'name:some person';
```

### Objective classification (Feature C)

`npm run classify:peopleforce-objectives` runs **after** the collector: it reads the latest objective snapshot and classifies each title with an LLM (is it L&D? course/book/sprint/…? which provider?) into `pf_objective_classification`. Needs `ANTHROPIC_API_KEY` + `DATABASE_URL`; model defaults to `claude-opus-4-8` (override with `PEOPLEFORCE_CLASSIFIER_MODEL`, e.g. `claude-haiku-4-5` for cost).

- Verdicts are keyed on `(objective_id, text_hash, classifier_version)` — a re-worded objective or a version bump re-classifies; nothing else does, so **historical dashboard counts don't shift silently**. Bump `CLASSIFIER_VERSION` only in a deliberate migration.
- `completion` is derived from the objective's structured `progress`, **not** the LLM (the reliable signal shouldn't inherit the fuzzy one's error).
- Low-confidence verdicts get `needs_review = TRUE` — a manual queue, not a silent count:
  ```sql
  SELECT * FROM pf_objective_classification WHERE needs_review ORDER BY confidence;
  ```

## Run it

```bash
PEOPLEFORCE_API_KEY=xxxxx \
DATABASE_URL=postgres://user:pass@host:5432/db \
npm run snapshot:peopleforce
```

Tables are created on first run (`CREATE TABLE IF NOT EXISTS`). Optional env:
`PEOPLEFORCE_BASE_URL` (non-default tenant), `PEOPLEFORCE_SNAPSHOT_MAX_PAGES`
(pagination safety cap, default 1000).

### Schedule (pick one)

**cron** (nightly at 02:00):
```
0 2 * * *  cd /path/to/repo && PEOPLEFORCE_API_KEY=xxx DATABASE_URL=postgres://… npm run snapshot:peopleforce >> /var/log/pf-snapshot.log 2>&1
```

**GitHub Actions**:
```yaml
on:
  schedule: [{ cron: '0 2 * * *' }]
jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run snapshot:peopleforce
        env:
          PEOPLEFORCE_API_KEY: ${{ secrets.PEOPLEFORCE_API_KEY }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

## Grafana queries

Point a Grafana **PostgreSQL** data source at the same DB. Each snapshot run
shares one `captured_at`, so `GROUP BY captured_at` gives you a time series.

**Skills portfolio over time** — how many people hold each skill per snapshot:
```sql
SELECT captured_at AS "time", skill_name, COUNT(DISTINCT employee_id) AS people
FROM pf_employee_skill_snapshot
GROUP BY captured_at, skill_name
ORDER BY captured_at;
```

**Dev Sprint completions over time** (custom-field tenants):
```sql
SELECT captured_at AS "time", COUNT(*) AS completed
FROM pf_employee_custom_field_snapshot
WHERE field_name ILIKE '%dev sprint%' AND field_value ILIKE '%complete%'
GROUP BY captured_at ORDER BY captured_at;
```

**L&D activities in a selected period** — objectives active in Grafana's range,
using the built-in `$__timeFilter` on the latest snapshot:
```sql
SELECT title, owner_name, status, progress, starts_on, ends_on
FROM pf_objective_snapshot
WHERE captured_at = (SELECT MAX(captured_at) FROM pf_objective_snapshot)
  AND daterange(starts_on, ends_on, '[]') && daterange($__timeFrom()::date, $__timeTo()::date, '[]');
```

**Participation trends across teams** — objectives joined to team via the
resolved owner mapping + employee dimension (stable `employee_id`, not name matching):
```sql
SELECT o.captured_at AS "time", d.department, COUNT(*) AS objectives
FROM pf_objective_snapshot o
JOIN pf_owner_resolution r
  ON r.owner_key = COALESCE('email:' || lower(o.owner_email), 'name:' || lower(o.owner_name))
JOIN pf_employee_dim d ON d.employee_id = r.employee_id
GROUP BY o.captured_at, d.department ORDER BY o.captured_at;
```

**L&D content authored per quarter** (free — articles carry their own `created_at`):
```sql
SELECT date_trunc('quarter', created_at) AS "time", author_name, COUNT(*) AS articles
FROM pf_kb_article_snapshot
WHERE captured_at = (SELECT MAX(captured_at) FROM pf_kb_article_snapshot)
GROUP BY 1, author_name ORDER BY 1;
```

**Learning activities by type over time** (uses the classifier — trustworthy, with a confidence floor):
```sql
SELECT o.captured_at AS "time", c.activity_type, COUNT(*) AS learning_objectives
FROM pf_objective_snapshot o
JOIN pf_objective_classification c
  ON c.objective_id = o.objective_id AND c.text_hash = encode(sha256(o.title::bytea), 'hex')
WHERE c.is_learning AND NOT c.needs_review
GROUP BY o.captured_at, c.activity_type ORDER BY o.captured_at;
```

**Overall L&D investment** (only if a tenant records spend as a custom field):
```sql
SELECT captured_at AS "time",
       SUM(NULLIF(regexp_replace(field_value, '[^0-9.]', '', 'g'), '')::numeric) AS total_spend
FROM pf_employee_custom_field_snapshot
WHERE field_name ILIKE '%l&d%spend%' OR field_name ILIKE '%training budget%'
GROUP BY captured_at ORDER BY captured_at;
```

## Limits (inherited from the API — see CLAUDE.md)

- **Courses completed / participation counts**: no first-class entity in the API.
  Only reachable if a tenant records them as custom fields (above) or as objective
  titles — the latter needs fuzzy string-matching and won't be exact.
- **Skills history is forward-only**: the first snapshot is your epoch; there is
  no retroactive history.
- **Per-employee skills = N calls per run** (no bulk endpoint). Fine nightly; be
  mindful of rate limits if you shorten the cadence.
- **Single-tenant**: the collector uses one `PEOPLEFORCE_API_KEY`. Multi-tenant
  (per-user tokens from `mcp_connections`) is not wired yet.
