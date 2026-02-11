// src/webServer.ts
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createProxyMiddleware } from 'http-proxy-middleware';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { loadUsers, createOrUpdateUser, getUserByGoogleId, getUserByApiKey, regenerateApiKey, UserRecord } from './userStore.js';
import { loadClientCredentials } from './auth.js';
import { registerOAuthRoutes, getOAuthState, deleteOAuthState, storeAuthCode } from './oauthServer.js';
import { createSession, getSession, deleteSession, Session } from './sessionStore.js';
import { clearSessionCache, createUserSession, UserSession } from './userSession.js';
import { listMcpCatalogs, getMcpCatalog, createMcpCatalog, updateMcpCatalog, deleteMcpCatalog } from './mcpCatalogStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Extend Express Request to include session
interface AuthenticatedRequest extends Request {
  session?: Session;
}

// Extend Express Request for API key auth
interface ApiAuthenticatedRequest extends Request {
  userSession?: UserSession;
  user?: UserRecord;
}

export function createWebApp(internalMcpPort: number): express.Express {
  const app = express();

  // Cookie parser middleware
  app.use(cookieParser(COOKIE_SECRET));

  // Direct health check for Railway (must be before proxy)
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // MCP OAuth authorization server endpoints (must be before proxy)
  registerOAuthRoutes(app);

  // Proxy MCP endpoints to internal FastMCP server
  const mcpProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${internalMcpPort}`,
    changeOrigin: true,
    ws: true,
    pathFilter: ['/mcp', '/sse'],
  });
  app.use(mcpProxy);

  // Registration page - redirect to dashboard if already logged in
  // Must be before express.static to intercept requests for /
  app.get('/', async (req: AuthenticatedRequest, res) => {
    const sessionId = req.signedCookies?.session;
    if (sessionId) {
      const session = await getSession(sessionId);
      if (session && session.expiresAt > Date.now()) {
        res.redirect('/dashboard');
        return;
      }
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Serve static files
  app.use(express.static(publicDir));

  // Start OAuth flow
  app.get('/auth/google', async (_req, res) => {
    try {
      const { client_id, client_secret } = await loadClientCredentials();
      const redirectUri = `${BASE_URL}/auth/callback`;
      const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',  // Force consent to always get refresh_token
      });

      res.redirect(authorizeUrl);
    } catch (err: any) {
      console.error('Error starting OAuth flow:', err);
      res.status(500).send('Failed to start authentication. Check server configuration.');
    }
  });

  // OAuth callback — handles both direct registration and MCP OAuth flows
  app.get('/auth/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    const stateParam = req.query.state as string | undefined;

    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }

    try {
      const { client_id, client_secret } = await loadClientCredentials();
      const redirectUri = `${BASE_URL}/auth/callback`;
      const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

      // Exchange Google auth code for tokens
      const { tokens } = await oauthClient.getToken(code);
      oauthClient.setCredentials(tokens);

      // Fetch user profile
      const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
      const { data: profile } = await oauth2.userinfo.get();

      if (!profile.email || !profile.id) {
        res.status(400).send('Could not retrieve Google profile information.');
        return;
      }

      // Create or update user
      await loadUsers();

      // Get existing user to preserve refresh_token if Google didn't send a new one
      const existingUser = await getUserByGoogleId(profile.id);

      const user = await createOrUpdateUser(
        {
          email: profile.email,
          googleId: profile.id,
          name: profile.name || profile.email,
        },
        {
          access_token: tokens.access_token!,
          // Preserve existing refresh_token if Google didn't send a new one
          refresh_token: tokens.refresh_token || existingUser?.tokens?.refresh_token || '',
          scope: tokens.scope!,
          token_type: tokens.token_type!,
          expiry_date: tokens.expiry_date!,
        }
      );

      // Clear cached session so new tokens take effect immediately
      clearSessionCache(user.apiKey);

      console.error(`User registered/updated: ${user.email} (API key: ${user.apiKey.substring(0, 8)}...)`);

      // Check if this is an MCP OAuth flow
      if (stateParam) {
        const oauthState = await getOAuthState(stateParam);
        if (oauthState) {
          await deleteOAuthState(stateParam);

          // Generate single-use authorization code
          const authCode = crypto.randomBytes(32).toString('hex');
          await storeAuthCode(authCode, {
            apiKey: user.apiKey,
            clientId: oauthState.clientId,
            codeChallenge: oauthState.codeChallenge,
            codeChallengeMethod: oauthState.codeChallengeMethod,
            redirectUri: oauthState.redirectUri,
            expiresAt: Date.now() + 600_000,
          });

          // Redirect back to Claude.ai with the authorization code
          const callbackUrl = new URL(oauthState.redirectUri);
          callbackUrl.searchParams.set('code', authCode);
          callbackUrl.searchParams.set('state', oauthState.state);

          console.error(`MCP OAuth: redirecting to ${callbackUrl.origin} for client ${oauthState.clientId}`);
          res.redirect(callbackUrl.toString());
          return;
        }
      }

      // Direct registration flow — create session and redirect to dashboard
      const sessionId = await createSession(profile.id);
      res.cookie('session', sessionId, {
        signed: true,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE,
      });
      res.redirect('/dashboard');
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // Authentication middleware for protected routes
  async function requireAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const sessionId = req.signedCookies?.session;
    if (!sessionId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const session = await getSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      res.clearCookie('session');
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    req.session = session;
    next();
  }

  // Dashboard page (protected)
  app.get('/dashboard', async (req: AuthenticatedRequest, res) => {
    const sessionId = req.signedCookies?.session;
    if (!sessionId) {
      res.redirect('/');
      return;
    }
    const session = await getSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      res.clearCookie('session');
      res.redirect('/');
      return;
    }
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // API endpoint to get current user info (protected)
  app.get('/api/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      await loadUsers();
      const user = await getUserByGoogleId(req.session!.googleId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({
        email: user.email,
        name: user.name,
        apiKey: user.apiKey,
        isAdmin: user.isAdmin === true,
      });
    } catch (err: any) {
      console.error('Error fetching user:', err);
      res.status(500).json({ error: 'Failed to fetch user data' });
    }
  });

  // Regenerate API key endpoint (protected)
  app.post('/api/regenerate-key', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await regenerateApiKey(req.session!.googleId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      console.error(`API key regenerated for user: ${user.email} (new key: ${user.apiKey.substring(0, 8)}...)`);
      res.json({ apiKey: user.apiKey });
    } catch (err: any) {
      console.error('Error regenerating API key:', err);
      res.status(500).json({ error: 'Failed to regenerate API key' });
    }
  });

  // Logout endpoint
  app.post('/api/logout', async (req: AuthenticatedRequest, res) => {
    const sessionId = req.signedCookies?.session;
    if (sessionId) {
      await deleteSession(sessionId);
    }
    res.clearCookie('session');
    res.json({ success: true });
  });

  // === MCP Catalog API (public endpoints) ===

  // GET /api/v1/catalogs - List all active MCPs
  app.get('/api/v1/catalogs', async (_req, res) => {
    try {
      const catalogs = await listMcpCatalogs();
      res.json({
        catalogs: catalogs.map(c => ({
          slug: c.slug,
          name: c.name,
          description: c.description,
          iconUrl: c.iconUrl,
          mcpUrl: c.mcpUrl,
        })),
      });
    } catch (err: any) {
      console.error('Error listing catalogs:', err);
      res.status(500).json({ error: 'Failed to list catalogs' });
    }
  });

  // GET /api/v1/catalogs/:slug - Get single MCP details
  app.get('/api/v1/catalogs/:slug', async (req, res) => {
    try {
      const catalog = await getMcpCatalog(req.params.slug);
      if (!catalog) {
        res.status(404).json({ error: 'Catalog not found' });
        return;
      }
      res.json({
        slug: catalog.slug,
        name: catalog.name,
        description: catalog.description,
        iconUrl: catalog.iconUrl,
        mcpUrl: catalog.mcpUrl,
      });
    } catch (err: any) {
      console.error('Error getting catalog:', err);
      res.status(500).json({ error: 'Failed to get catalog' });
    }
  });

  // === Admin API Endpoints (protected) ===

  // JSON body parser for admin endpoints
  app.use('/api/v1/admin', express.json());

  // Admin authentication middleware
  async function requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const sessionId = req.signedCookies?.session;
    if (!sessionId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const session = await getSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      res.clearCookie('session');
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    await loadUsers();
    const user = await getUserByGoogleId(session.googleId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    req.session = session;
    next();
  }

  // POST /api/v1/admin/catalogs - Create new MCP
  app.post('/api/v1/admin/catalogs', requireAdmin, async (req, res) => {
    try {
      const { slug, name, description, mcpUrl, iconUrl, isLocal } = req.body;

      if (!slug || !name || !mcpUrl) {
        res.status(400).json({ error: 'slug, name, and mcpUrl are required' });
        return;
      }

      // Validate slug format (alphanumeric with hyphens)
      if (!/^[a-z0-9-]+$/.test(slug)) {
        res.status(400).json({ error: 'slug must contain only lowercase letters, numbers, and hyphens' });
        return;
      }

      const catalog = await createMcpCatalog({
        slug,
        name,
        description: description || '',
        mcpUrl,
        iconUrl: iconUrl || null,
        isLocal: isLocal ?? true,
        isActive: true,
      });

      console.error(`Admin: Created MCP catalog "${slug}"`);
      res.status(201).json({
        slug: catalog.slug,
        name: catalog.name,
        description: catalog.description,
        iconUrl: catalog.iconUrl,
        mcpUrl: catalog.mcpUrl,
        isLocal: catalog.isLocal,
      });
    } catch (err: any) {
      console.error('Error creating catalog:', err);
      res.status(500).json({ error: 'Failed to create catalog' });
    }
  });

  // PUT /api/v1/admin/catalogs/:slug - Update MCP
  app.put('/api/v1/admin/catalogs/:slug', requireAdmin, async (req, res) => {
    try {
      const { name, description, mcpUrl, iconUrl, isLocal } = req.body;
      const slug = req.params.slug as string;

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (mcpUrl !== undefined) updates.mcpUrl = mcpUrl;
      if (iconUrl !== undefined) updates.iconUrl = iconUrl;
      if (isLocal !== undefined) updates.isLocal = isLocal;

      const catalog = await updateMcpCatalog(slug, updates);
      if (!catalog) {
        res.status(404).json({ error: 'Catalog not found' });
        return;
      }

      console.error(`Admin: Updated MCP catalog "${slug}"`);
      res.json({
        slug: catalog.slug,
        name: catalog.name,
        description: catalog.description,
        iconUrl: catalog.iconUrl,
        mcpUrl: catalog.mcpUrl,
        isLocal: catalog.isLocal,
      });
    } catch (err: any) {
      console.error('Error updating catalog:', err);
      res.status(500).json({ error: 'Failed to update catalog' });
    }
  });

  // DELETE /api/v1/admin/catalogs/:slug - Delete MCP (soft delete)
  app.delete('/api/v1/admin/catalogs/:slug', requireAdmin, async (req, res) => {
    try {
      const slug = req.params.slug as string;
      const deleted = await deleteMcpCatalog(slug);
      if (!deleted) {
        res.status(404).json({ error: 'Catalog not found' });
        return;
      }

      console.error(`Admin: Deleted MCP catalog "${slug}"`);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error deleting catalog:', err);
      res.status(500).json({ error: 'Failed to delete catalog' });
    }
  });

  // === REST API for ChatGPT Integration ===

  // API key authentication middleware for REST endpoints
  async function requireApiKey(
    req: ApiAuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <apiKey>' });
      return;
    }

    const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix
    if (!apiKey) {
      res.status(401).json({ error: 'API key is required' });
      return;
    }

    try {
      await loadUsers();
      const user = await getUserByApiKey(apiKey);
      if (!user) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      // Create user session with Google API clients
      const { client_id, client_secret } = await loadClientCredentials();
      const userSession = createUserSession(user, client_id, client_secret);

      req.user = user;
      req.userSession = userSession;
      next();
    } catch (err: any) {
      console.error('API key auth error:', err);
      res.status(500).json({ error: 'Authentication failed' });
    }
  }

  // JSON body parser for API endpoints
  app.use('/api/v1', express.json());

  // Serve OpenAPI spec
  app.get('/openapi.json', (_req, res) => {
    res.sendFile(path.join(publicDir, 'openapi.json'));
  });

  // POST /api/v1/docs/read - Read a Google Doc
  app.post('/api/v1/docs/read', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { documentId, format = 'text', maxLength, tabId } = req.body;

      if (!documentId) {
        res.status(400).json({ error: 'documentId is required' });
        return;
      }

      const docs = req.userSession!.googleDocs;
      const needsTabsContent = !!tabId;
      const fields = format === 'json' || format === 'markdown'
        ? '*'
        : 'body(content(paragraph(elements(textRun(content)))))';

      const docResponse = await docs.documents.get({
        documentId,
        includeTabsContent: needsTabsContent,
        fields: needsTabsContent ? '*' : fields,
      });

      // Handle tab selection
      let contentSource: any;
      if (tabId) {
        const targetTab = findTabById(docResponse.data, tabId);
        if (!targetTab) {
          res.status(404).json({ error: `Tab with ID "${tabId}" not found` });
          return;
        }
        if (!targetTab.documentTab) {
          res.status(400).json({ error: `Tab "${tabId}" does not have content` });
          return;
        }
        contentSource = { body: targetTab.documentTab.body };
      } else {
        contentSource = docResponse.data;
      }

      // Format response based on requested format
      if (format === 'json') {
        let jsonContent = JSON.stringify(contentSource, null, 2);
        if (maxLength && jsonContent.length > maxLength) {
          jsonContent = jsonContent.substring(0, maxLength);
        }
        res.json({ format: 'json', content: JSON.parse(jsonContent) });
        return;
      }

      // Extract text content
      let textContent = '';
      contentSource.body?.content?.forEach((element: any) => {
        if (element.paragraph?.elements) {
          element.paragraph.elements.forEach((pe: any) => {
            if (pe.textRun?.content) {
              textContent += pe.textRun.content;
            }
          });
        }
        if (element.table?.tableRows) {
          element.table.tableRows.forEach((row: any) => {
            row.tableCells?.forEach((cell: any) => {
              cell.content?.forEach((cellElement: any) => {
                cellElement.paragraph?.elements?.forEach((pe: any) => {
                  if (pe.textRun?.content) {
                    textContent += pe.textRun.content;
                  }
                });
              });
            });
          });
        }
      });

      if (maxLength && textContent.length > maxLength) {
        textContent = textContent.substring(0, maxLength);
      }

      res.json({
        format: 'text',
        content: textContent,
        length: textContent.length,
      });
    } catch (err: any) {
      console.error('Error reading doc:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read document' });
      }
    }
  });

  // GET /api/v1/docs/:documentId/comments - List comments
  app.get('/api/v1/docs/:documentId/comments', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const drive = google.drive({ version: 'v3', auth: req.userSession!.oauthClient });

      const response = await drive.comments.list({
        fileId: documentId,
        fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime))',
        pageSize: 100,
      });

      const comments = response.data.comments || [];

      res.json({
        documentId,
        count: comments.length,
        comments: comments.map((comment: any) => ({
          id: comment.id,
          content: comment.content,
          quotedText: comment.quotedFileContent?.value || null,
          author: comment.author?.displayName || 'Unknown',
          createdTime: comment.createdTime,
          resolved: comment.resolved || false,
          replies: (comment.replies || []).map((reply: any) => ({
            id: reply.id,
            content: reply.content,
            author: reply.author?.displayName || 'Unknown',
            createdTime: reply.createdTime,
          })),
        })),
      });
    } catch (err: any) {
      console.error('Error listing comments:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to list comments' });
      }
    }
  });

  // POST /api/v1/docs/:documentId/comments - Add a comment
  app.post('/api/v1/docs/:documentId/comments', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const { startIndex, endIndex, commentText } = req.body;

      if (!commentText) {
        res.status(400).json({ error: 'commentText is required' });
        return;
      }

      if (startIndex === undefined || endIndex === undefined) {
        res.status(400).json({ error: 'startIndex and endIndex are required' });
        return;
      }

      if (endIndex <= startIndex) {
        res.status(400).json({ error: 'endIndex must be greater than startIndex' });
        return;
      }

      // Get the quoted text from the document
      const docs = req.userSession!.googleDocs;
      const doc = await docs.documents.get({ documentId });

      let quotedText = '';
      const content = doc.data.body?.content || [];

      for (const element of content) {
        if (element.paragraph) {
          const elements = element.paragraph.elements || [];
          for (const textElement of elements) {
            if (textElement.textRun) {
              const elementStart = textElement.startIndex || 0;
              const elementEnd = textElement.endIndex || 0;

              if (elementEnd > startIndex && elementStart < endIndex) {
                const text = textElement.textRun.content || '';
                const startOffset = Math.max(0, startIndex - elementStart);
                const endOffset = Math.min(text.length, endIndex - elementStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }
      }

      // Create the comment using Drive API
      const drive = google.drive({ version: 'v3', auth: req.userSession!.oauthClient });

      const response = await drive.comments.create({
        fileId: documentId,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved',
        requestBody: {
          content: commentText,
          quotedFileContent: {
            value: quotedText,
            mimeType: 'text/html',
          },
        },
      });

      res.status(201).json({
        id: response.data.id,
        content: response.data.content,
        quotedText: response.data.quotedFileContent?.value || null,
        author: response.data.author?.displayName || 'Unknown',
        createdTime: response.data.createdTime,
        resolved: response.data.resolved || false,
      });
    } catch (err: any) {
      console.error('Error adding comment:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to add comment' });
      }
    }
  });

  return app;
}

// Helper function to find a tab by ID in a document
function findTabById(doc: any, tabId: string): any {
  if (!doc.tabs || doc.tabs.length === 0) {
    return null;
  }

  const searchTabs = (tabs: any[]): any => {
    for (const tab of tabs) {
      if (tab.tabProperties?.tabId === tabId) {
        return tab;
      }
      if (tab.childTabs && tab.childTabs.length > 0) {
        const found = searchTabs(tab.childTabs);
        if (found) return found;
      }
    }
    return null;
  };

  return searchTabs(doc.tabs);
}
