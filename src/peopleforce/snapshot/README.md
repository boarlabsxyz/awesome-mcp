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
| `pf_snapshot_run` | — | run log (status + per-table counts) |

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

**Participation trends across teams** — objectives joined to department via the
roster snapshot (uses `owner_email`, a stable key, not name matching):
```sql
SELECT o.captured_at AS "time", e.department, COUNT(*) AS objectives
FROM pf_objective_snapshot o
LEFT JOIN pf_employee_snapshot e
  ON e.captured_at = o.captured_at AND e.email = o.owner_email
GROUP BY o.captured_at, e.department ORDER BY o.captured_at;
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
