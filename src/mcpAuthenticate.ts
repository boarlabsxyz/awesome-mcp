// src/mcpAuthenticate.ts
// Shared authenticate handler for all MCP servers.
import http from 'http';
import { UserSession, createUserSession, createUserSessionFromConnection, createClickUpSession } from './userSession.js';
import { loadUsers, getUserByApiKey, getUserById } from './userStore.js';
import { loadClientCredentials } from './auth.js';
import { getMcpConnection, getMcpConnectionByInstanceId } from './mcpConnectionStore.js';
import { getMcpCatalog } from './mcpCatalogStore.js';

/** Dependencies injected for testability. */
export interface AuthDeps {
  loadUsers: () => Promise<void>;
  getUserByApiKey: (key: string) => Promise<any>;
  getUserById: (id: number) => Promise<any>;
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
  getUserById,
  loadClientCredentials,
  getMcpConnection,
  getMcpConnectionByInstanceId,
  getMcpCatalog,
  createUserSession: createUserSession as any,
  createUserSessionFromConnection: createUserSessionFromConnection as any,
  createClickUpSession,
};

/** Create a session from a verified connection. */
async function sessionFromConnection(user: any, connection: any, deps: AuthDeps): Promise<UserSession> {
  if (connection.provider === 'clickup') {
    return deps.createClickUpSession(user, connection);
  }
  const mcp = await deps.getMcpCatalog(connection.mcpSlug);
  const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
    ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
    : await deps.loadClientCredentials();
  return deps.createUserSessionFromConnection(user, connection, client_id, client_secret);
}

/** Resolve a user + optional instanceId/slug to a session. */
async function resolveSession(user: any, mcpSlug: string, instanceId: string | undefined, deps: AuthDeps): Promise<UserSession> {
  if (instanceId) {
    const connection = await deps.getMcpConnectionByInstanceId(instanceId);
    if (!connection) {
      throw new Response(null, { status: 404, statusText: `Instance not found: ${instanceId}` } as any);
    }
    if (connection.userId !== user.id) {
      console.error(`[mcp-auth] Instance ${instanceId} belongs to userId=${connection.userId}, but authenticated userId=${user.id} (email=${user.email})`);
      throw new Response(null, { status: 403, statusText: 'You do not have access to this instance.' } as any);
    }
    return sessionFromConnection(user, connection, deps);
  }

  // Legacy flow: find connection by slug
  const connection = await deps.getMcpConnection(user.id, mcpSlug);
  if (connection) {
    return sessionFromConnection(user, connection, deps);
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

  // JWT pre-authenticated path: the resource server middleware already validated the token
  // and forwarded the internal user ID via a trusted header. Only trust this header from
  // the local proxy (127.0.0.1 / ::1) to prevent spoofing from external clients.
  const remoteAddr = request.socket?.remoteAddress;
  const isLocalProxy = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  const trustedUserId = isLocalProxy ? request.headers['x-mcp-user-id'] : undefined;
  if (trustedUserId && typeof trustedUserId === 'string') {
    const user = await deps.getUserById(Number(trustedUserId));
    if (!user) {
      throw new Response(null, { status: 401, statusText: 'JWT-authenticated user not found.' } as any);
    }
    const url = new URL(request.url || '', 'http://localhost');
    const instanceId = url.searchParams.get('instanceId') || undefined;
    return resolveSession(user, mcpSlug, instanceId, deps);
  }

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

  return resolveSession(user, mcpSlug, instanceId, deps);
}

/**
 * Creates a FastMCP authenticate handler for the given MCP slug.
 * Uses real dependencies by default.
 */
export function createMcpAuthenticateHandler(mcpSlug: string) {
  return (request: http.IncomingMessage | undefined) => authenticateRequest(request, mcpSlug, defaultDeps);
}
