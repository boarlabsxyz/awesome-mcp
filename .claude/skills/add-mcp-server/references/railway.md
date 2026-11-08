# Railway service provisioning

Reference for step 8 of `add-mcp-server`. Read only if the user opts into Railway provisioning.

## Layout assumption

This repo deploys via **one Railway project with two environments** (`development` and `production`). `.github/workflows/deploy.yml` uses a single `RAILWAY_TOKEN` and switches environments with `--environment`. Every MCP is its own Railway **service** inside that one project; each service reuses the same `Dockerfile` and `railway.json`, differentiating at boot via `MCP_SLUG`.

**Do not** create separate projects per env — it breaks the existing CI, doubles the token count, and forces the user to keep two catalogs in sync.

## Target MCP server

Assume `jason-tan-swe/railway-mcp` is connected. Tool names below match that server. If those exact names don't resolve, look for the closest analog (e.g. `service_update_source` may be split from `service_create`).

Common tools used:

| Intent | Likely tool |
|--------|-------------|
| List projects | `project_list` |
| List environments in a project | `project_info` (usually returns `environments`) or `list_environments` |
| List services in a project | `service_list` |
| Create service from a GitHub repo | `service_create_from_repo` |
| Bulk-set variables for one service + env | `variable_bulk_set` |
| List variables (to detect existing template) | `variable_list` |
| Create a domain on a service | `domain_create` |

If the Railway MCP isn't connected, skip step 8 entirely with a one-line note. Do not fail the scaffold.

## Variable plan

Split by whether the value differs per environment:

### Literal, differs per env

| Variable | dev value | prod value |
|----------|-----------|------------|
| `MCP_MODE` | `mcp` | `mcp` |
| `MCP_SLUG` | `<slug>` | `<slug>` |
| `TRANSPORT` | `httpStream` | `httpStream` |
| `NODE_ENV` | `development` | `production` |
| `BASE_URL` | dev service URL | prod service URL |

`BASE_URL` needs the auto-generated Railway domain per environment. If `service_create_from_repo` returned the URLs, use them. Otherwise call `domain_create` (or read `service_info`) once per env after the service exists.

### Reference syntax, identical string in both envs

Railway resolves `${{...}}` per-environment at build time, so the same string in dev and prod resolves to different values without exposing secrets in the conversation.

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `COOKIE_SECRET` | `${{<template>.COOKIE_SECRET}}` |
| `GOOGLE_CREDENTIALS` | `${{<template>.GOOGLE_CREDENTIALS}}` — Google providers only |
| `GOOGLE_CLIENT_ID` | `${{<template>.GOOGLE_CLIENT_ID}}` — Google providers using per-MCP creds |
| `GOOGLE_CLIENT_SECRET` | `${{<template>.GOOGLE_CLIENT_SECRET}}` — same |

`<template>` defaults to `google-docs`. If the user set a different template, substitute.

For third-party providers, drop the `GOOGLE_*` rows and, if applicable, reference the OAuth client from the template service (e.g. `${{<template>.CLICKUP_CLIENT_ID}}`) — but only if that variable actually exists on the template. If not, leave it unset and flag in the report.

## Procedure

1. **Gather inputs** with one `AskUserQuestion`:
   - Railway project ID (or name — resolve via `project_list`).
   - Template service (default: `google-docs`).
   - GitHub repo `owner/name` (default: read from `git remote get-url origin`).

2. **Discover environments**: call `project_info` and grab `development` + `production` env IDs. If either is missing, stop the Railway step and tell the user to create them.

3. **Verify template service exists** in the project (`service_list`). If not, stop and ask for a different template.

4. **Create service** via `service_create_from_repo`. Service name = `<slug>` — matches the value the user must add to the `RAILWAY_SERVICES` GitHub variable. Capture the returned service ID.

5. **Resolve BASE_URL per env**: if the create response includes generated domains, use them. Otherwise call `domain_create` (or read `service_info`) targeting each environment.

6. **Bulk-set variables** — one `variable_bulk_set` call per environment. Send all literal + reference vars in the same call so partial failures don't leave the service half-configured.

7. **Update GitHub Actions**: `.github/workflows/deploy.yml` reads `RAILWAY_SERVICES` per-environment. Read current values with `gh variable get RAILWAY_SERVICES --env dev` and `--env prod`, append `<slug>`, and write back with `gh variable set`. If `gh` isn't authenticated, print the exact commands the user should run and continue.

8. **Report** (folded into step 9 of the parent skill): service ID, dev + prod URLs, template used, and any variable that couldn't be resolved (Postgres/Redis missing, template secret missing) as a "fix in Railway UI" bullet.

## Failure modes

- **Railway MCP not connected** — print a one-line note and skip. Don't attempt to fake tool calls.
- **Project has no `development` or `production` environment** — stop; tell the user which is missing.
- **GitHub repo not connected to Railway** — `service_create_from_repo` fails with a permissions error. Surface it verbatim; the user has to install the Railway GitHub app.
- **Template service doesn't exist in the project** — abort the Railway step. Ask for a different template or fall back to leaving those variables unset.
- **`gh` CLI not authenticated** — don't try to log in. Print the exact `gh variable set` commands the user needs to run and move on.
- **Postgres or Redis not in the project** — the create still succeeds, but `${{Postgres.DATABASE_URL}}` won't resolve at build. Flag in the report as "fix in Railway UI".
