# Contributing to awesome-mcp

This document describes the development workflow, branching strategy, and CI/CD pipeline for the `awesome-mcp` project.

---

## Branch Strategy

We use a **GitHub Flow + develop buffer** model:

```
main          ← production (auto-deploys to Railway prod on every merge)
  └── develop ← integration branch (auto-deploys to Railway dev on every push)
        └── feature/xyz     ← your work
        └── fix/some-bug
        └── chore/update-deps
```

### Rules

| Branch | Who can push | Protected | Auto-deploys |
|--------|-------------|-----------|-------------|
| `main` | No one directly — merge via PR only | ✅ | → Production |
| `develop` | No one directly — merge via PR only | ✅ | → Dev |
| `feature/*`, `fix/*`, `chore/*` | Author | ❌ | CI only |

---

## Day-to-Day Workflow

### 1. Start a new piece of work

```bash
git checkout develop
git pull origin develop
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

### 3. Push and open a PR to `develop`

```bash
git push origin feature/my-feature-name
```

Then open a PR targeting `develop`. The CI pipeline (`ci.yml`) will automatically:
- Run lint + type check
- Run all tests
- Run the build

All checks must be green. At least 1 approval is required.

### 4. Dev deploy (automatic)

Once your PR merges to `develop`, the **Deploy → Dev** workflow fires automatically and deploys to the Railway dev environment. Verify your change there.

### 5. Promote to production

Open a PR from `develop` → `main`. This goes through the same CI gate plus a required review. Once merged, the **Deploy → Production** workflow fires automatically.

> ⚠️ **Never push directly to `main` or `develop`.**

---

## CI/CD Pipelines

### `ci.yml` — Runs on all PRs and feature pushes
- Lint → Type check → Tests → Build
- Blocks merging if any step fails

### `deploy-dev.yml` — Runs on push to `develop`
- Runs tests as a safety gate
- Deploys to Railway `dev` environment
- Posts result to Slack `#deploys`

### `deploy-prod.yml` — Runs on push to `main`
- Runs full test suite (hard gate — no bypass)
- Deploys to Railway `production` environment
- Posts result to Slack `#deploys`

### `pr-quality.yml` — Runs on all PRs
- Validates PR title follows Conventional Commits
- Warns if PR changes more than 1000 lines

---

## Required GitHub Secrets

Set these in **Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `RAILWAY_TOKEN_DEV` | Railway API token scoped to dev environment |
| `RAILWAY_TOKEN_PROD` | Railway API token scoped to production environment |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for deploy notifications |

## Required GitHub Variables

Set these in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Example |
|----------|---------|
| `DEV_APP_URL` | `https://awesome-mcp-dev.up.railway.app` |
| `PROD_APP_URL` | `https://awesome-mcp.up.railway.app` |
| `RAILWAY_SERVICE_DEV` | `awesome-mcp-dev` |
| `RAILWAY_SERVICE_PROD` | `awesome-mcp` |

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
