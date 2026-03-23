# CI/CD Pipeline Setup — awesome-mcp

Drop-in GitHub Actions pipeline for `boarlabsxyz/awesome-mcp`.

## What's included

```
.github/
  workflows/
    ci.yml               ← Lint + test + build on every PR and feature push
    deploy-dev.yml       ← Auto-deploy to Railway dev on push to `develop`
    deploy-prod.yml      ← Auto-deploy to Railway prod on merge to `main`
    pr-quality.yml       ← Conventional Commits title check + PR size warning
  branch-protection.yml  ← Docs-as-code: branch protection settings to apply manually
  pull_request_template.md
CONTRIBUTING.md          ← Full workflow documentation for the team
src/__tests__/
  placeholder.test.ts   ← Test file that runs in CI immediately
package.scripts.json     ← Scripts to add to package.json
```

## One-time setup checklist

### 1. Copy files into your repo

```bash
# From the root of your awesome-mcp checkout:
cp -r .github/ CONTRIBUTING.md src/__tests__/placeholder.test.ts .
```

### 2. Add scripts to package.json

Merge the contents of `package.scripts.json` into your `package.json` `scripts` block.

### 3. Create the `develop` branch

```bash
git checkout -b develop
git push origin develop
```

### 4. Add GitHub Secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Where to get it |
|--------|----------------|
| `RAILWAY_TOKEN_DEV` | Railway → Project → Settings → Tokens |
| `RAILWAY_TOKEN_PROD` | Railway → Project → Settings → Tokens |
| `SLACK_WEBHOOK_URL` | Slack → App → Incoming Webhooks |

### 5. Add GitHub Variables

Settings → Secrets and variables → Actions → **Variables tab**:

| Variable | Value |
|----------|-------|
| `DEV_APP_URL` | Your Railway dev URL |
| `PROD_APP_URL` | Your Railway prod URL |
| `RAILWAY_SERVICE_DEV` | Railway service name for dev |
| `RAILWAY_SERVICE_PROD` | Railway service name for prod |

### 6. Apply branch protection

Follow the settings documented in `.github/branch-protection.yml`:
- Settings → Branches → Add rule for `main` and `develop`
- Require status checks: **Lint & Test**, **Build**
- Require 1 approving review
- Disallow force pushes

### 7. Verify

Open a test PR from a `feature/` branch into `develop` and confirm the CI workflow runs green.

---

## Pipeline flow

```
feature/xyz  →  PR to develop  →  CI (lint + test + build)
                                         ↓ merge
                               develop  →  Deploy → Dev  (Railway dev)
                                         ↓ PR to main
                               main     →  Deploy → Prod (Railway prod)
```
