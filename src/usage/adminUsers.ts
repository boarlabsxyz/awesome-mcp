// Every account with its MCP connections — the /admin Users tab and the Admin
// MCP's listUsers read the same list from here.
import { loadUsers, getAllUsers } from '../userStore.js';
import { getUserConnectedMcps } from '../mcpConnectionStore.js';

export interface AdminUserConnection {
  mcpSlug: string;
  instanceName: string;
  googleEmail: string | null;
}

export interface AdminUser {
  id: number | undefined;
  email: string;
  name: string | null | undefined;
  authMethod: string | undefined;
  createdAt: string | Date | undefined;
  connectionCount: number;
  connections: AdminUserConnection[];
  /**
   * True when this user's connections could not be read. Their count then
   * reads 0, which must not be mistaken for "has no connections".
   */
  connectionsUnavailable: boolean;
}

export interface AdminUserDeps {
  loadUsers: () => Promise<void>;
  getAllUsers: () => Promise<any[]>;
  getUserConnectedMcps: (userId: number) => Promise<any[]>;
}

const defaultDeps: AdminUserDeps = { loadUsers, getAllUsers, getUserConnectedMcps };

/** All users with their connections. A failed connection read is flagged per user, not thrown. */
export async function listUsersWithConnections(deps: AdminUserDeps = defaultDeps): Promise<AdminUser[]> {
  await deps.loadUsers();
  const allUsers = await deps.getAllUsers();
  return Promise.all(
    allUsers.map(async (u): Promise<AdminUser> => {
      let connections: AdminUserConnection[] = [];
      let connectionsUnavailable = false;
      if (u.id) {
        try {
          const mcpConns = await deps.getUserConnectedMcps(u.id);
          connections = mcpConns.map((c) => ({
            mcpSlug: c.mcpSlug,
            instanceName: c.instanceName,
            googleEmail: c.googleEmail ?? null,
          }));
        } catch {
          connectionsUnavailable = true;
        }
      }
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        authMethod: u.authMethod,
        createdAt: u.createdAt,
        connectionCount: connections.length,
        connections,
        connectionsUnavailable,
      };
    }),
  );
}
