// src/mcpCatalogStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDatabaseAvailable, getPool } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const CATALOG_FILE = path.join(DATA_DIR, 'mcp-catalog.json');

export interface McpCatalogEntry {
  id: number;
  slug: string;
  name: string;
  description: string;
  iconUrl: string | null;
  mcpUrl: string;
  isLocal: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------- File-based storage (fallback) ----------

let catalog: McpCatalogEntry[] = [];
let loaded = false;
let writeLock: Promise<void> = Promise.resolve();
let nextId = 1;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function fileLoadCatalog(): Promise<void> {
  if (loaded) return;
  await ensureDataDir();
  try {
    const content = await fs.readFile(CATALOG_FILE, 'utf-8');
    catalog = JSON.parse(content);
    nextId = catalog.length > 0 ? Math.max(...catalog.map(e => e.id)) + 1 : 1;
    loaded = true;
    console.error(`Loaded ${catalog.length} MCP catalog entries from ${CATALOG_FILE}`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      catalog = [];
      loaded = true;
      console.error('No existing MCP catalog file, starting fresh.');
    } else {
      throw err;
    }
  }
}

async function saveCatalog(): Promise<void> {
  writeLock = writeLock.then(async () => {
    await ensureDataDir();
    await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
  });
  await writeLock;
}

async function fileListMcpCatalogs(): Promise<McpCatalogEntry[]> {
  await fileLoadCatalog();
  return catalog.filter(e => e.isActive);
}

async function fileGetMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  await fileLoadCatalog();
  return catalog.find(e => e.slug === slug && e.isActive) || null;
}

async function fileCreateMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  await fileLoadCatalog();

  // Check if slug already exists
  const existing = catalog.find(e => e.slug === entry.slug);
  if (existing) {
    // Update existing entry
    existing.name = entry.name;
    existing.description = entry.description;
    existing.iconUrl = entry.iconUrl;
    existing.mcpUrl = entry.mcpUrl;
    existing.isLocal = entry.isLocal;
    existing.isActive = entry.isActive;
    existing.updatedAt = new Date().toISOString();
    await saveCatalog();
    return existing;
  }

  const newEntry: McpCatalogEntry = {
    id: nextId++,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    iconUrl: entry.iconUrl,
    mcpUrl: entry.mcpUrl,
    isLocal: entry.isLocal,
    isActive: entry.isActive,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  catalog.push(newEntry);
  await saveCatalog();
  return newEntry;
}

async function fileUpdateMcpCatalog(
  slug: string,
  updates: Partial<Omit<McpCatalogEntry, 'id' | 'slug' | 'createdAt' | 'updatedAt'>>
): Promise<McpCatalogEntry | null> {
  await fileLoadCatalog();
  const existing = catalog.find(e => e.slug === slug);
  if (!existing) return null;

  if (updates.name !== undefined) existing.name = updates.name;
  if (updates.description !== undefined) existing.description = updates.description;
  if (updates.iconUrl !== undefined) existing.iconUrl = updates.iconUrl;
  if (updates.mcpUrl !== undefined) existing.mcpUrl = updates.mcpUrl;
  if (updates.isLocal !== undefined) existing.isLocal = updates.isLocal;
  if (updates.isActive !== undefined) existing.isActive = updates.isActive;
  existing.updatedAt = new Date().toISOString();

  await saveCatalog();
  return existing;
}

async function fileDeleteMcpCatalog(slug: string): Promise<boolean> {
  await fileLoadCatalog();
  const existing = catalog.find(e => e.slug === slug);
  if (!existing) return false;

  existing.isActive = false;
  existing.updatedAt = new Date().toISOString();
  await saveCatalog();
  return true;
}

// ---------- Database-backed storage ----------

async function dbListMcpCatalogs(): Promise<McpCatalogEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, icon_url, mcp_url, is_local, is_active, created_at, updated_at
     FROM mcp_catalog
     WHERE is_active = true
     ORDER BY name`
  );
  return rows.map(mapRowToEntry);
}

async function dbGetMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, icon_url, mcp_url, is_local, is_active, created_at, updated_at
     FROM mcp_catalog
     WHERE slug = $1 AND is_active = true`,
    [slug]
  );
  if (rows.length === 0) return null;
  return mapRowToEntry(rows[0]);
}

async function dbCreateMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  const pool = getPool();
  const now = new Date();

  const { rows } = await pool.query(
    `INSERT INTO mcp_catalog (slug, name, description, icon_url, mcp_url, is_local, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       icon_url = EXCLUDED.icon_url,
       mcp_url = EXCLUDED.mcp_url,
       is_local = EXCLUDED.is_local,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at
     RETURNING id, slug, name, description, icon_url, mcp_url, is_local, is_active, created_at, updated_at`,
    [entry.slug, entry.name, entry.description, entry.iconUrl, entry.mcpUrl, entry.isLocal, entry.isActive, now]
  );

  return mapRowToEntry(rows[0]);
}

async function dbUpdateMcpCatalog(
  slug: string,
  updates: Partial<Omit<McpCatalogEntry, 'id' | 'slug' | 'createdAt' | 'updatedAt'>>
): Promise<McpCatalogEntry | null> {
  const pool = getPool();
  const now = new Date();

  // Build dynamic SET clause
  const setClauses: string[] = ['updated_at = $1'];
  const values: any[] = [now];
  let paramIndex = 2;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }
  if (updates.iconUrl !== undefined) {
    setClauses.push(`icon_url = $${paramIndex++}`);
    values.push(updates.iconUrl);
  }
  if (updates.mcpUrl !== undefined) {
    setClauses.push(`mcp_url = $${paramIndex++}`);
    values.push(updates.mcpUrl);
  }
  if (updates.isLocal !== undefined) {
    setClauses.push(`is_local = $${paramIndex++}`);
    values.push(updates.isLocal);
  }
  if (updates.isActive !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    values.push(updates.isActive);
  }

  values.push(slug);

  const { rows } = await pool.query(
    `UPDATE mcp_catalog SET ${setClauses.join(', ')} WHERE slug = $${paramIndex}
     RETURNING id, slug, name, description, icon_url, mcp_url, is_local, is_active, created_at, updated_at`,
    values
  );

  if (rows.length === 0) return null;
  return mapRowToEntry(rows[0]);
}

async function dbDeleteMcpCatalog(slug: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE mcp_catalog SET is_active = false, updated_at = NOW() WHERE slug = $1`,
    [slug]
  );
  return (rowCount ?? 0) > 0;
}

function mapRowToEntry(row: any): McpCatalogEntry {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    iconUrl: row.icon_url,
    mcpUrl: row.mcp_url,
    isLocal: row.is_local,
    isActive: row.is_active,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// ---------- Public API ----------

export async function listMcpCatalogs(): Promise<McpCatalogEntry[]> {
  if (isDatabaseAvailable()) {
    return dbListMcpCatalogs();
  }
  return fileListMcpCatalogs();
}

export async function getMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  if (isDatabaseAvailable()) {
    return dbGetMcpCatalog(slug);
  }
  return fileGetMcpCatalog(slug);
}

export async function createMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  if (isDatabaseAvailable()) {
    return dbCreateMcpCatalog(entry);
  }
  return fileCreateMcpCatalog(entry);
}

export async function updateMcpCatalog(
  slug: string,
  updates: Partial<Omit<McpCatalogEntry, 'id' | 'slug' | 'createdAt' | 'updatedAt'>>
): Promise<McpCatalogEntry | null> {
  if (isDatabaseAvailable()) {
    return dbUpdateMcpCatalog(slug, updates);
  }
  return fileUpdateMcpCatalog(slug, updates);
}

export async function deleteMcpCatalog(slug: string): Promise<boolean> {
  if (isDatabaseAvailable()) {
    return dbDeleteMcpCatalog(slug);
  }
  return fileDeleteMcpCatalog(slug);
}

export async function seedDefaultCatalogs(): Promise<void> {
  console.error('Seeding default MCP catalog entries...');

  await createMcpCatalog({
    slug: 'google-docs',
    name: 'Google Docs MCP',
    description: 'Read, write, and manage Google Docs, Sheets, and Drive',
    iconUrl: null,
    mcpUrl: '/mcp',
    isLocal: true,
    isActive: true,
  });

  console.error('Default MCP catalog entries seeded.');
}
