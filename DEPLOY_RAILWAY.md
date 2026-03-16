# Railway Deployment Guide - Multi-Service MCP Architecture

## Deployment Options

The code supports two deployment approaches:

| Approach | Complexity | Best For |
|----------|------------|----------|
| **Single Service** | Simple | Most users, getting started |
| **Multi-Service** | Advanced | Large scale, separate domains per MCP |

---

## Option 1: Single Service Deployment (Recommended)

One Railway service runs everything: website + all MCPs via internal proxies.

### Step 1: Create Railway Project

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub and select the repository

### Step 2: Add PostgreSQL

1. In your project, click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. Railway auto-sets `DATABASE_URL`

### Step 3: Add Redis

1. Click **"+ New"** → **"Database"** → **"Redis"**
2. Railway auto-sets `REDIS_URL`

### Step 4: Configure Environment Variables

In your app service → **Variables** tab, add these variables one by one:

| Variable Name | Value to Paste |
|---------------|----------------|
| `TRANSPORT` | `httpStream` |
| `BASE_URL` | `https://your-app-name.up.railway.app` (replace with your actual Railway URL) |
| `GOOGLE_CREDENTIALS` | See below |
| `COOKIE_SECRET` | Any random string, e.g. `my-super-secret-cookie-key-12345` |
| `NODE_ENV` | `production` |

**How to get `GOOGLE_CREDENTIALS`:**

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Go to **APIs & Services** → **Credentials**
4. Click on your OAuth 2.0 Client ID (or create one)
5. You'll see:
   - **Client ID:** `123456789-abcdefg.apps.googleusercontent.com`
   - **Client Secret:** `GOCSPX-xxxxxxxxxxxxxxx`
6. Format as JSON and paste into Railway:

```
{"client_id":"123456789-abcdefg.apps.googleusercontent.com","client_secret":"GOCSPX-xxxxxxxxxxxxxxx"}
```

**Example Railway Variables Screenshot:**
```
TRANSPORT         = httpStream
BASE_URL          = https://google-docs-mcp.up.railway.app
GOOGLE_CREDENTIALS = {"client_id":"123456789-abc.apps.googleusercontent.com","client_secret":"GOCSPX-xxx"}
COOKIE_SECRET     = replace-with-random-string-at-least-32-chars
NODE_ENV          = production
```

**Note:** `DATABASE_URL` and `REDIS_URL` are automatically set by Railway when you add PostgreSQL and Redis databases.

### Step 5: Update Google Cloud OAuth

Add these **Authorized redirect URIs** in Google Cloud Console:

```
https://your-app.up.railway.app/auth/callback
https://your-app.up.railway.app/connect/google-docs/callback
https://your-app.up.railway.app/connect/google-calendar/callback
https://your-app.up.railway.app/connect/google-sheets/callback
```

### Step 6: Deploy

1. Push to GitHub → Railway auto-deploys
2. Or click **"Deploy"** in Railway dashboard

### Step 7: Verify

1. `https://your-app.up.railway.app/health` → `{"status":"ok"}`
2. `https://your-app.up.railway.app/` → Registration page
3. Create account with email/password
4. Dashboard shows MCPs with "Connect" buttons
5. Connect an MCP → Redirects to Google OAuth → Returns to dashboard

### Architecture (Single Service)

```
Railway Project
├── PostgreSQL
│   ├── users (email, password_hash, auth_method)
│   ├── mcp_connections (user_id, mcp_slug, google_tokens)
│   └── mcp_catalog (slug, credentials)
├── Redis
│   └── sessions, tokens, OAuth state
└── App Service (single container)
    ├── Express Web Server (:8080)
    │   ├── /              → Registration/Login
    │   ├── /dashboard     → MCP catalog + connections
    │   ├── /auth/*        → Password auth endpoints
    │   ├── /connect/*     → Per-MCP OAuth flows
    │   ├── /mcp           → Docs MCP (proxy → :3001)
    │   ├── /calendar      → Calendar MCP (proxy → :3002)
    │   └── /sheets        → Sheets MCP (proxy → :3003)
    ├── Docs MCP Server (internal :3001)
    ├── Calendar MCP Server (internal :3002)
    └── Sheets MCP Server (internal :3003)
```

---

## Option 2: Multi-Service Deployment (Advanced)

Separate Railway services for website and each MCP. Useful for:
- Different domains per MCP
- Independent scaling
- Separate Google Cloud projects per MCP

### Step 1: Create Project with Multiple Services

1. Create Railway project
2. Add PostgreSQL and Redis (shared)
3. Create 4 services:
   - `website` - Web UI + OAuth
   - `google-docs-mcp` - Docs MCP only
   - `google-calendar-mcp` - Calendar MCP only
   - `google-sheets-mcp` - Sheets MCP only

### Step 2: Configure Website Service

**Variables:**
```
MCP_MODE=web
BASE_URL=https://website.up.railway.app
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
COOKIE_SECRET=xxx
GOOGLE_CREDENTIALS={"client_id":"xxx","client_secret":"xxx"}
NODE_ENV=production
```

**Note:** The website service handles registration, login, and per-MCP OAuth flows. It does NOT proxy MCP requests.

### Step 3: Configure Google Docs MCP Service

**Variables:**
```
MCP_MODE=mcp
MCP_SLUG=google-docs
BASE_URL=https://google-docs-mcp.up.railway.app
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
GOOGLE_CLIENT_ID=docs-specific-client-id
GOOGLE_CLIENT_SECRET=docs-specific-secret
TRANSPORT=httpStream
NODE_ENV=production
```

### Step 4: Configure Google Calendar MCP Service

**Variables:**
```
MCP_MODE=mcp
MCP_SLUG=google-calendar
BASE_URL=https://google-calendar-mcp.up.railway.app
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
GOOGLE_CLIENT_ID=calendar-specific-client-id
GOOGLE_CLIENT_SECRET=calendar-specific-secret
TRANSPORT=httpStream
NODE_ENV=production
```

### Step 5: Configure Google Sheets MCP Service

**Variables:**
```
MCP_MODE=mcp
MCP_SLUG=google-sheets
BASE_URL=https://google-sheets-mcp.up.railway.app
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
GOOGLE_CLIENT_ID=sheets-specific-client-id
GOOGLE_CLIENT_SECRET=sheets-specific-secret
TRANSPORT=httpStream
NODE_ENV=production
```

### Step 6: Google Cloud OAuth Setup

For multi-service deployment, you have two options:

---

#### Option A: Separate Google Cloud Projects (Recommended)

Each MCP gets its own Google Cloud project with minimal scopes. This provides:
- **Scope isolation** - Users only grant permissions for the specific MCP they're connecting
- **Cleaner consent screens** - Each OAuth screen shows only relevant permissions
- **Independent verification** - Each project can be verified separately by Google

**Step A1: Create Google Docs MCP Project**

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click **Select Project** → **New Project**
3. Name: `Google Docs MCP`
4. Click **Create**

**Step A2: Enable APIs for Docs Project**

In your Docs project, go to **APIs & Services** → **Library** and enable:
- Google Docs API
- Google Drive API

**Step A3: Configure OAuth Consent Screen for Docs**

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External**
3. Fill in app name: `Google Docs MCP`
4. Add scopes:
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/drive
```
5. Add test users (your email)

**Step A4: Create OAuth Client for Docs**

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Choose **Web application**
4. Name: `Docs MCP Client`
5. Add **Authorized redirect URIs**:
```
https://YOUR-WEBSITE.up.railway.app/connect/google-docs/callback
```
6. Copy the **Client ID** and **Client Secret**

**Step A5: Create Google Calendar MCP Project**

Repeat steps A1-A4 for Calendar:

1. Create new project: `Google Calendar MCP`
2. Enable APIs: **Google Calendar API**
3. Configure OAuth consent screen with scopes:
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events
```
4. Create OAuth client with redirect URI:
```
https://YOUR-WEBSITE.up.railway.app/connect/google-calendar/callback
```

**Step A7: Create Google Sheets MCP Project**

Repeat steps A1-A4 for Sheets:

1. Create new project: `Google Sheets MCP`
2. Enable APIs: **Google Sheets API**, **Google Drive API**
3. Configure OAuth consent screen with scopes:
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive
```
4. Create OAuth client with redirect URI:
```
https://YOUR-WEBSITE.up.railway.app/connect/google-sheets/callback
```

**Step A8: Configure Railway Services**

Now use the credentials from each project:

**Google Docs MCP Service:**
```
GOOGLE_CLIENT_ID=YOUR_DOCS_PROJECT_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_DOCS_PROJECT_CLIENT_SECRET
```

**Google Calendar MCP Service:**
```
GOOGLE_CLIENT_ID=YOUR_CALENDAR_PROJECT_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CALENDAR_PROJECT_CLIENT_SECRET
```

**Google Sheets MCP Service:**
```
GOOGLE_CLIENT_ID=YOUR_SHEETS_PROJECT_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_SHEETS_PROJECT_CLIENT_SECRET
```

**Website Service** (uses any project's credentials for initial login):
```
GOOGLE_CREDENTIALS={"client_id":"xxx","client_secret":"xxx"}
```

---

#### Option B: Single Project, Multiple OAuth Clients

Simpler setup but all MCPs share the same consent screen with all scopes combined.

1. Create one Google Cloud project
2. Enable all APIs (Docs, Drive, Sheets, Calendar)
3. Create one OAuth consent screen with all scopes
4. Create separate OAuth clients for each MCP (each with different redirect URIs)

---

**Redirect URIs Summary:**

For the **Website Service** (handles all OAuth flows):
```
https://website.up.railway.app/auth/callback
https://website.up.railway.app/connect/google-docs/callback
https://website.up.railway.app/connect/google-calendar/callback
https://website.up.railway.app/connect/google-sheets/callback
```

### Architecture (Multi-Service)

```
Railway Project
├── PostgreSQL (shared)
├── Redis (shared)
├── Website Service
│   ├── Registration/Login
│   ├── Dashboard
│   └── Per-MCP OAuth flows
├── Google Docs MCP Service
│   └── /mcp endpoint (validates user connected this MCP)
├── Google Calendar MCP Service
│   └── /mcp endpoint (validates user connected this MCP)
└── Google Sheets MCP Service
    └── /mcp endpoint (validates user connected this MCP)
```

---

## User Journey After Deployment

1. **Visit website** → `https://your-app.up.railway.app`
2. **Register** with email/password (or Google)
3. **Dashboard** shows available MCPs
4. **Click "Connect"** on Google Docs → Google OAuth (only docs/drive scopes)
5. **Click "Connect"** on Google Calendar → Google OAuth (only calendar scopes)
5. **Click "Connect"** on Google Sheets → Google OAuth (only spreadsheets/drive scopes)
6. **Add to Claude.ai:**
   - Settings → Connectors → Add custom connector
   - URL: `https://your-app.up.railway.app/mcp?apiKey=YOUR_API_KEY`
7. **Use tools** - MCP validates user has connected it

---

## Google Cloud Setup (Step-by-Step)

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click **Select Project** → **New Project**
3. Name: `Google Docs MCP` (or your preferred name)
4. Click **Create**

### Step 2: Enable APIs

In your project, go to **APIs & Services** → **Library** and enable:

**For Google Docs MCP:**
- Google Docs API
- Google Drive API

**For Google Calendar MCP:**
- Google Calendar API

**For Google Sheets MCP:**
- Google Sheets API
- Google Drive API

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External** (unless you have Google Workspace)
3. Fill in:
   - **App name:** `Google Docs MCP Server`
   - **User support email:** Your email
   - **Developer contact:** Your email
4. Click **Save and Continue**

### Step 4: Add Scopes

1. Click **Add or Remove Scopes**
2. Add these scopes:

**For Google Docs MCP:**
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/drive
```

**For Google Calendar MCP:**
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events
```

**For Google Sheets MCP:**
```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive
```

3. Click **Save and Continue**

### Step 5: Add Test Users (While in Testing Mode)

1. Click **Add Users**
2. Add your email address and any test users
3. Click **Save and Continue**

**Note:** While your app is in "Testing" mode, only these users can authenticate. To allow anyone, submit for verification.

### Step 6: Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Choose **Web application**
4. Name: `MCP Web Client`
5. Add **Authorized redirect URIs**:

```
https://YOUR-RAILWAY-APP.up.railway.app/auth/callback
https://YOUR-RAILWAY-APP.up.railway.app/connect/google-docs/callback
https://YOUR-RAILWAY-APP.up.railway.app/connect/google-calendar/callback
https://YOUR-RAILWAY-APP.up.railway.app/connect/google-sheets/callback
```

**For local development, also add:**
```
http://localhost:8080/auth/callback
http://localhost:8080/connect/google-docs/callback
http://localhost:8080/connect/google-calendar/callback
http://localhost:8080/connect/google-sheets/callback
```

6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

### Step 7: Format Credentials for Railway

Create the `GOOGLE_CREDENTIALS` environment variable:

```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

**Example:**
```
GOOGLE_CREDENTIALS={"client_id":"123456789-abc.apps.googleusercontent.com","client_secret":"GOCSPX-xxxxx"}
```

### Publishing Your App (Beyond Test Users)

While in "Testing" mode, only users you manually add can authenticate. To allow anyone:

1. Go to **OAuth consent screen**
2. Click **Publish App**
3. For sensitive scopes (Drive, Docs), Google requires verification:
   - Submit app for review
   - Provide privacy policy URL
   - Explain your use case
   - Wait for approval (can take weeks)

**Alternative for internal use:** Use Google Workspace and set to "Internal" - only users in your organization can authenticate.

### Optional: Separate Projects for Each MCP

For maximum scope isolation, create separate Google Cloud projects:

**Project 1: Google Docs MCP**
- Enable: Docs API, Drive API
- Consent screen scopes: Only docs/drive
- OAuth client → Set as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for Docs MCP

**Project 2: Google Calendar MCP**
- Enable: Calendar API
- Consent screen scopes: Only calendar
- OAuth client → Set as separate credentials for Calendar MCP

**Project 3: Google Sheets MCP**
- Enable: Sheets API, Drive API
- Consent screen scopes: Only spreadsheets/drive
- OAuth client → Set as separate credentials for Sheets MCP

---

## Environment Variables Reference

### Core Variables (All Deployments)

| Variable | Required | Description |
|----------|----------|-------------|
| `TRANSPORT` | Yes | Set to `httpStream` for HTTP mode |
| `BASE_URL` | Yes | Public URL (e.g., `https://app.up.railway.app`) |
| `COOKIE_SECRET` | Yes | Random string for session security |
| `DATABASE_URL` | Auto | PostgreSQL URL (Railway sets) |
| `REDIS_URL` | Auto | Redis URL (Railway sets) |
| `NODE_ENV` | No | Set to `production` for secure cookies |

### Google Credentials (Choose One Method)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CREDENTIALS` | JSON with `client_id` and `client_secret` (single-service) |
| `GOOGLE_CLIENT_ID` | Direct client ID (multi-service, per-MCP credentials) |
| `GOOGLE_CLIENT_SECRET` | Direct client secret (multi-service, per-MCP credentials) |

**Priority:** `GOOGLE_CLIENT_ID`/`SECRET` > `GOOGLE_CREDENTIALS` > `credentials.json` file

### Multi-Service Variables

| Variable | Description |
|----------|-------------|
| `MCP_MODE` | `web` (website only), `mcp` (MCP only), or `all` (default) |
| `MCP_SLUG` | For `MCP_MODE=mcp`: `google-docs`, `google-calendar`, or `google-sheets` |

---

## Troubleshooting

### "MCP not connected" error in Claude
- User hasn't connected this specific MCP
- Visit dashboard and click "Connect" on the MCP

### OAuth redirect_uri mismatch
- Add ALL callback URLs to Google Cloud:
  - `/auth/callback` (legacy Google login)
  - `/connect/google-docs/callback`
  - `/connect/google-calendar/callback`
  - `/connect/google-sheets/callback`

### Database connection failed
- Verify PostgreSQL addon is attached
- Check `DATABASE_URL` in environment

### Password users can't use MCPs
- Password-auth users MUST connect each MCP individually
- Legacy Google OAuth users have all scopes from initial auth

---

## Verification Checklist

- [ ] `/health` returns `{"status":"ok"}`
- [ ] Registration page loads at `/`
- [ ] Can create account with email/password
- [ ] Dashboard shows MCPs with connection status
- [ ] "Connect" button starts Google OAuth
- [ ] After connecting, MCP shows as "Connected"
- [ ] Can copy MCP URL with API key
- [ ] Claude.ai can connect and use tools
