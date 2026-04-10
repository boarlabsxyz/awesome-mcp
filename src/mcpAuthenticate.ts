// src/mcpAuthenticate.ts
// Shared authenticate handler for all MCP servers.
import http from 'http';
import { UserSession, createUserSession, createUserSessionFromConnection, createClickUpSession } from './userSession.js';
import { loadUsers, getUserByApiKey } from './userStore.js';
import { loadClientCredentials } from './auth.js';
import { getMcpConnection, getMcpConnectionByInstanceId } from './mcpConnectionStore.js';
import { getMcpCatalog } from './mcpCatalogStore.js';

/** Dependencies injected for testability. */
export interface AuthDeps {
  loadUsers: () => Promise<void>;
  getUserByApiKey: (key: string) => Promise<any>;
  loadClientCredentials: () => Promise<{ client_id: string; client_secret: string }>;
  getMcpConnection: (userId: any, slug: string) => Promise<any>;
  getMcpConnectionByInstanceId: (id: string) => Promise<any>;
  getMcpCatalog: (slug: string) => Promise<any>;
  createUserSession: (user: any, clientId: string, clientSecret: string) => Promise<UserSession>;
  createUserSessionFromConnection: (user: any, conn: any, clientId: string, clientSecret: string) => Promise<UserSession>;
  createClickUpSession: (user: any, conn: any) => UserSession;
}

/** Default dependencies wired to real implementations. */
const defaultDeps: AuthDeps = {
  loadUsers,
  getUserByApiKey,
  loadClientCredentials,
  getMcpConnection,
  getMcpConnectionByInstanceId,
  getMcpCatalog,
  createUserSession: createUserSession as any,
  createUserSessionFromConnection: createUserSessionFromConnection as any,
  createClickUpSession,
};

/**
 * Core authenticate logic, extracted for testability.
 * All MCP servers (docs, calendar, sheets, gmail) use the same auth logic;
 * only the slug differs for the legacy (no instanceId) flow.
 */
export async function authenticateRequest(
  request: http.IncomingMessage | undefined,
  mcpSlug: string,
  deps: AuthDeps,
): Promise<UserSession> {
  // In stdio mode, request is undefined — no per-user auth needed
  if (!request) return undefined as unknown as UserSession;

  // Extract API key from Authorization header or query param
  const authHeader = request.headers['authorization'];
  let rawToken: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    rawToken = authHeader.slice(7);
  }

  const url = new URL(request.url || '', 'http://localhost');

  if (!rawToken) {
    rawToken = url.searchParams.get('apiKey') || undefined;
  }

  if (!rawToken) {
    throw new Response(null, { status: 401, statusText: 'Missing API key. Provide Authorization: Bearer <key> header.' } as any);
  }

  // Support compound token format: "apiKey.instanceId"
  let apiKey: string;
  let instanceId: string | undefined;

  await deps.loadUsers();

  const dotIndex = rawToken.lastIndexOf('.');
  if (dotIndex > 0) {
    const possibleApiKey = rawToken.substring(0, dotIndex);
    const possibleInstanceId = rawToken.substring(dotIndex + 1);
    const possibleUser = await deps.getUserByApiKey(possibleApiKey);
    if (possibleUser) {
      apiKey = possibleApiKey;
      instanceId = possibleInstanceId;
    } else {
      apiKey = rawToken;
    }
  } else {
    apiKey = rawToken;
  }

  if (!instanceId) {
    instanceId = url.searchParams.get('instanceId') || undefined;
  }

  const user = await deps.getUserByApiKey(apiKey);
  if (!user) {
    throw new Response(null, { status: 401, statusText: 'Invalid API key.' } as any);
  }

  if (!user.id) {
    throw new Response(null, { status: 403, statusText: 'User ID not found. Please re-register.' } as any);
  }

  if (instanceId) {
    const connection = await deps.getMcpConnectionByInstanceId(instanceId);
    if (!connection) {
      throw new Response(null, { status: 404, statusText: `Instance not found: ${instanceId}` } as any);
    }
    if (connection.userId !== user.id) {
      throw new Response(null, { status: 403, statusText: 'You do not have access to this instance.' } as any);
    }

    // Branch on provider: ClickUp uses its own session factory
    if (connection.provider === 'clickup') {
      return deps.createClickUpSession(user, connection);
    }

    const mcp = await deps.getMcpCatalog(connection.mcpSlug);
    const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
      ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
      : await deps.loadClientCredentials();

    return deps.createUserSessionFromConnection(user, connection, client_id, client_secret);
  }

  // Legacy flow (no instanceId): Always prefer MCP connection tokens
  const connection = await deps.getMcpConnection(user.id, mcpSlug);
  if (connection) {
    // Branch on provider: ClickUp uses its own session factory
    if (connection.provider === 'clickup') {
      return deps.createClickUpSession(user, connection);
    }

    const mcp = await deps.getMcpCatalog(mcpSlug);
    const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
      ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
      : await deps.loadClientCredentials();
    return deps.createUserSessionFromConnection(user, connection, client_id, client_secret);
  }

  // Fall back to user's global tokens
  if (user.tokens && user.tokens.refresh_token) {
    const { client_id, client_secret } = await deps.loadClientCredentials();
    return deps.createUserSession(user, client_id, client_secret);
  }

  throw new Response(null, {
    status: 403,
    statusText: `MCP not connected. Visit the dashboard to connect ${mcpSlug}.`
  } as any);
}

/**
 * Creates a FastMCP authenticate handler for the given MCP slug.
 * Uses real dependencies by default.
 */
export function createMcpAuthenticateHandler(mcpSlug: string) {
  return (request: http.IncomingMessage | undefined) => authenticateRequest(request, mcpSlug, defaultDeps);
}
