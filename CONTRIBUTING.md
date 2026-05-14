# Contributing to awesome-mcp

This document describes the development workflow, branching strategy, and CI/CD pipeline for the `awesome-mcp` project.

---

## Branch Strategy

We use a **trunk-based + tag-driven** model with two environments:

```
main                ← trunk (auto-deploys to dev on every push)
  └── feature/xyz   ← your work (CI only, no deploy)
  └── fix/some-bug
v* tags on main     ← prod deploys (tag-triggered, CI-gated)
```

### Rules

| Branch / Tag | Who can push | Protected | Deploys to |
|-------------|-------------|-----------|------------|
| `main` | Merge via PR only | ✅ | Dev |
| `feature/*`, `fix/*`, `chore/*` | Author | ❌ | Nothing |
| `v*` tags | Admins via `create-tag` workflow | ✅ (tag ruleset) | Prod |

---

## Day-to-Day Workflow

### 1. Start a new piece of work

```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature-name
```

Branch naming:
- `feature/` — new functionality
- `fix/` — bug fixes
- `chore/` — maintenance, deps, tooling

### 2. Commit using Conventional Commits

```
<type>(optional scope): <short description>

feat: add OAuth token refresh
fix(auth): handle expired session tokens correctly
chore: upgrade @railway/cli to v3
docs: clarify setup steps in README
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert`

### 3. Reference ClickUp tasks in commits

Include `CU-<taskId>` anywhere in the commit message (subject or body) to link commits to ClickUp tasks. The task ID is the alphanumeric ID from the ClickUp URL (e.g., `app.clickup.com/t/86c9abc`).

```
feat(dashboard): add connection status badges CU-86c9abc

fix(auth): handle expired tokens

Fixes the session timeout issue reported in CU-abc1234.
Also addresses CU-def5678.
```

Multiple `CU-` references per commit are supported. These are automatically parsed by the release notes workflow to enrich changelogs with ClickUp task titles and links.

### 4. Push and open a PR to `main`

```bash
git push origin feature/my-feature-name
```

Then open a PR targeting `main`. The CI pipeline runs lint, typecheck, tests, and build. All checks must be green. At least 1 approval is required.

### 5. Dev deploy (automatic)

Once your PR merges to `main`, CI passes, then the **Deploy → Dev** workflow fires automatically. Verify your change in the dev environment.

### 6. Release to prod

When ready, run **Create Tag (CI-gated)** from the Actions tab with a `v*` tag (e.g., `v1.0.0`) pointing to `main`. The workflow verifies CI passed, creates the tag, which triggers the prod deploy and release notes generation.

> ⚠️ **Never push directly to `main`.**

---

## CI/CD Pipelines

### `ci.yml` — Runs on all pushes and PRs to main
- Lint → Type check → Tests → Build (parallel)
- On `main` push: triggers dev deploy

### `deploy-dev.yml` — Triggered by CI after main push
- Deploys to Railway dev environment via reusable `deploy.yml`
- Posts result to Slack

### `deploy-prod.yml` — Triggered by v* tag push
- Deploys to Railway production environment
- Posts result to Slack

### `release-notes.yml` — Triggered by v* tag push
- Collects commits between tags, resolves ClickUp task titles
- Posts release notes to Slack
- Updates `/updates` page (commits to repo)
- Sends email notification to all users

### `create-tag.yml` — Manual workflow for gated tag creation
- Validates CI passed on the target commit
- Creates and pushes the tag

### `pr-quality.yml` — Runs on all PRs
- Validates PR title follows Conventional Commits
- Warns if PR changes more than 1000 lines

---

## Required GitHub Configuration

### Secrets (per environment)

| Secret | Scope | Description |
|--------|-------|-------------|
| `RAILWAY_TOKEN` | dev, prod environments | Railway API token |
| `SLACK_WEBHOOK_URL` | all environments | Slack webhook for notifications |
| `CLICKUP_API_TOKEN` | repository | ClickUp API token for release notes |
| `INTERNAL_API_KEY` | repository | Shared secret for internal API endpoint |

### Variables (per environment)

| Variable | Scope | Example |
|----------|-------|---------|
| `RAILWAY_SERVICES` | dev, prod environments | `awesome-mcp` |
| `APP_URL` | dev, prod environments | `https://awesome-mcp-dev.up.railway.app` |

---

## Local Development

```bash
npm install         # install dependencies
npm test            # run tests
npm run lint        # lint
npm run typecheck   # type check
npm run build       # build
```

Tests use the placeholder in `src/__tests__/` — add real tests alongside your code.

---

## Getting Help

- Open a GitHub Discussion for questions
- Tag `@evgen` or `@peter` in your PR for a review
