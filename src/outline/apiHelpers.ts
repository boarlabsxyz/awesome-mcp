// src/outline/apiHelpers.ts
// Adapted from https://github.com/Vortiago/mcp-outline@e699cd5d16a983c7bcb4e67c3cf213608df7eeac
// (endpoints and payloads correspond to Outline's public REST API)

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';

/**
 * Default base URL used only when no per-connection URL is stored and no
 * OUTLINE_BASE_URL env var is set. In production, either the user provides the
 * URL when pasting their API key, or (for OAuth deployments) the seed writes
 * the env var into the catalog.
 */
const DEFAULT_BASE_URL = process.env.OUTLINE_BASE_URL || 'https://wiki-dev.gluzdov.com';

export type OutlineDocument = {
  id: string;
  title?: string;
  text?: string;
  url?: string;
  collectionId?: string;
  parentDocumentId?: string | null;
  updatedAt?: string;
  createdAt?: string;
  publishedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

export type OutlineCollection = {
  id: string;
  name?: string;
  description?: string;
  color?: string;
};

export type OutlineComment = {
  id: string;
  createdBy?: { name?: string };
  createdAt?: string;
  anchorText?: string;
  data?: unknown;
};

export type OutlineCollectionNode = {
  id: string;
  title?: string;
  children?: OutlineCollectionNode[];
};

export type OutlineFileOperation = {
  id: string;
  state?: string;
  type?: string;
  name?: string;
};

export type OutlinePagination = {
  limit?: number;
  offset?: number;
  total?: number;
};

export type OutlineSearchResult = {
  ranking?: number;
  context?: string;
  document?: OutlineDocument;
};

export type StatusFilter = 'draft' | 'archived' | 'published';
export type DateFilter = 'day' | 'week' | 'month' | 'year';
export type ExportFormat = 'outline-markdown' | 'json' | 'html';

export class OutlineClient {
  /** Base URL of the Outline instance this client talks to (no trailing slash). */
  public readonly baseUrl: string;

  constructor(private token: string, baseUrl?: string) {
    // Strip trailing slashes so `${baseUrl}${path}` never doubles up.
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { redirect?: RequestRedirect },
  ): Promise<{ data?: T; ok: boolean; status: number; finalUrl?: string; json?: any }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: init?.redirect ?? 'follow',
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`Outline API ${method} ${path} timed out after 30000ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`Outline API ${method} ${path} failed: ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    let json: any = undefined;
    if (res.headers.get('content-type')?.includes('application/json')) {
      json = await res.json();
    }
    return { data: json?.data, ok: true, status: res.status, finalUrl: res.url, json };
  }

  async post<T = any>(path: string, body?: unknown): Promise<any> {
    const res = await this.request<T>('POST', path, body ?? {});
    return res.json;
  }

  // === Documents ===

  getDocument(id: string): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.info', { id }).then(r => r?.data);
  }

  createDocument(input: {
    title: string;
    collectionId: string;
    text?: string;
    parentDocumentId?: string;
    publish?: boolean;
    template?: boolean;
    icon?: string;
  }): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.create', input).then(r => r?.data);
  }

  updateDocument(input: {
    id: string;
    title?: string;
    text?: string;
    append?: boolean;
    template?: boolean;
    icon?: string | null;
  }): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.update', input).then(r => r?.data);
  }

  moveDocument(input: {
    id: string;
    collectionId?: string;
    parentDocumentId?: string;
  }): Promise<any> {
    return this.post('/api/documents.move', input);
  }

  archiveDocument(id: string): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.archive', { id }).then(r => r?.data);
  }

  unarchiveDocument(id: string): Promise<OutlineDocument | undefined> {
    // Outline exposes a single `/api/documents.restore` endpoint for both
    // archive-restoration and trash-restoration. There is no
    // `/api/documents.unarchive`; hitting that returns 404 which the tool
    // surfaces as "not found." Confirmed against wiki.gluzdov.com and
    // matches the reference implementation (Vortiago/mcp-outline maps
    // both `unarchive_document` and `restore_document` to documents.restore).
    return this.post('/api/documents.restore', { id }).then(r => r?.data);
  }

  restoreDocument(id: string): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.restore', { id }).then(r => r?.data);
  }

  moveToTrash(id: string): Promise<{ success?: boolean }> {
    return this.post('/api/documents.delete', { id });
  }

  permanentlyDeleteDocument(id: string): Promise<{ success?: boolean }> {
    return this.post('/api/documents.delete', { id, permanent: true });
  }

  listArchivedDocuments(): Promise<OutlineDocument[]> {
    return this.post('/api/documents.archived').then(r => (r?.data ?? []) as OutlineDocument[]);
  }

  listTrash(): Promise<OutlineDocument[]> {
    return this.post('/api/documents.deleted').then(r => (r?.data ?? []) as OutlineDocument[]);
  }

  searchDocuments(input: {
    query: string;
    collectionId?: string;
    limit?: number;
    offset?: number;
    statusFilter?: StatusFilter[];
    sort?: string;
    direction?: 'ASC' | 'DESC';
    dateFilter?: DateFilter;
  }): Promise<{ data: OutlineSearchResult[]; pagination?: OutlinePagination }> {
    const body: Record<string, unknown> = {
      query: input.query,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    };
    if (input.collectionId) body.collectionId = input.collectionId;
    if (input.statusFilter) body.statusFilter = input.statusFilter;
    if (input.sort) body.sort = input.sort;
    if (input.direction) body.direction = input.direction;
    if (input.dateFilter) body.dateFilter = input.dateFilter;
    return this.post('/api/documents.search', body).then(r => ({
      data: (r?.data ?? []) as OutlineSearchResult[],
      pagination: r?.pagination,
    }));
  }

  listDocuments(input: {
    backlinkDocumentId?: string;
    collectionId?: string;
    parentDocumentId?: string;
    limit?: number;
    offset?: number;
    sort?: string;
    direction?: 'ASC' | 'DESC';
  }): Promise<OutlineDocument[]> {
    return this.post('/api/documents.list', input).then(r => (r?.data ?? []) as OutlineDocument[]);
  }

  exportDocument(id: string): Promise<string> {
    return this.post('/api/documents.export', { id }).then(r => (r?.data ?? '') as string);
  }

  // === Collections ===

  listCollections(input?: { limit?: number; offset?: number }): Promise<OutlineCollection[]> {
    return this.post('/api/collections.list', {
      limit: input?.limit ?? 100,
      offset: input?.offset ?? 0,
    }).then(r => (r?.data ?? []) as OutlineCollection[]);
  }

  createCollection(input: {
    name: string;
    description?: string;
    color?: string;
  }): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.create', input).then(r => r?.data);
  }

  updateCollection(input: {
    id: string;
    name?: string;
    description?: string;
    color?: string;
  }): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.update', input).then(r => r?.data);
  }

  deleteCollection(id: string): Promise<{ success?: boolean }> {
    return this.post('/api/collections.delete', { id });
  }

  getCollectionDocuments(id: string): Promise<OutlineCollectionNode[]> {
    return this.post('/api/collections.documents', { id }).then(
      r => (r?.data ?? []) as OutlineCollectionNode[],
    );
  }

  exportCollection(id: string, format: ExportFormat): Promise<OutlineFileOperation | undefined> {
    return this.post('/api/collections.export', { id, format }).then(r => r?.fileOperation ?? r?.data);
  }

  exportAllCollections(format: ExportFormat): Promise<OutlineFileOperation | undefined> {
    return this.post('/api/collections.export_all', { format }).then(r => r?.fileOperation ?? r?.data);
  }

  // === Comments ===

  listDocumentComments(input: {
    documentId: string;
    includeAnchorText?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ data: OutlineComment[]; pagination?: OutlinePagination }> {
    return this.post('/api/comments.list', {
      documentId: input.documentId,
      includeAnchorText: input.includeAnchorText ?? false,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    }).then(r => ({
      data: (r?.data ?? []) as OutlineComment[],
      pagination: r?.pagination,
    }));
  }

  getComment(id: string, includeAnchorText = false): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.info', { id, includeAnchorText }).then(r => r?.data);
  }

  createComment(input: {
    documentId: string;
    text: string;
    parentCommentId?: string;
  }): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.create', input).then(r => r?.data);
  }

  // === Attachments ===

  /** Resolve an attachment ID to a signed download URL by following the redirect. */
  async getAttachmentRedirectUrl(id: string): Promise<string> {
    const res = await this.request<unknown>('POST', '/api/attachments.redirect', { id }, {
      redirect: 'follow',
    });
    return res.finalUrl ?? '';
  }
}

// ==== Formatting helpers (shared with server.ts, ported from mcp-outline) ====

export function formatFileOperation(op: OutlineFileOperation | undefined): string {
  if (!op) return 'No file operation data available.';
  const state = op.state ?? 'unknown';
  const type = op.type ?? 'unknown';
  const name = op.name ?? 'unknown';
  const id = op.id ?? '';
  const lines = [
    `# Export Operation: ${name}`,
    '',
    `State: ${state}`,
    `Type: ${type}`,
    `ID: ${id}`,
    '',
  ];
  if (state === 'complete') {
    lines.push(
      'The export is complete and ready to download. Use the ID with the appropriate download tool to retrieve the file.',
    );
  } else {
    lines.push(`The export is still in progress. Check the operation state again later using the ID: ${id}`);
  }
  return lines.join('\n');
}

export function formatDocumentsList(documents: OutlineDocument[], title: string): string {
  if (documents.length === 0) return `No ${title.toLowerCase()} found.`;
  const parts = [`# ${title}`, ''];
  documents.forEach((doc, i) => {
    parts.push(`## ${i + 1}. ${doc.title ?? 'Untitled'}`);
    parts.push(`ID: ${doc.id ?? ''}`);
    if (doc.updatedAt) parts.push(`Last Updated: ${doc.updatedAt}`);
    parts.push('');
  });
  return parts.join('\n');
}

export function formatCollections(collections: OutlineCollection[]): string {
  if (collections.length === 0) return 'No collections found.';
  const parts = ['# Collections', ''];
  collections.forEach((c, i) => {
    parts.push(`## ${i + 1}. ${c.name ?? 'Untitled Collection'}`);
    parts.push(`ID: ${c.id ?? ''}`);
    if (c.description) parts.push(`Description: ${c.description}`);
    parts.push('');
  });
  return parts.join('\n');
}

export function formatSearchResults(
  results: OutlineSearchResult[],
  pagination?: OutlinePagination,
): string {
  if (results.length === 0) return 'No documents found matching your search.';
  const parts = ['# Search Results', ''];
  if (pagination) {
    const limit = pagination.limit ?? 25;
    const offset = pagination.offset ?? 0;
    const start = offset + 1;
    const end = offset + results.length;
    parts.push(`Showing results ${start}-${end}`);
    if (results.length === limit) {
      parts.push(`More results may be available. Use offset=${offset + limit} to see more.`);
    }
    parts.push('');
  }
  results.forEach((result, i) => {
    const doc: Partial<OutlineDocument> = result.document ?? {};
    parts.push(`## ${i + 1}. ${doc.title ?? 'Untitled'}`);
    parts.push(`ID: ${doc.id ?? ''}`);
    if (typeof result.ranking === 'number') parts.push(`Relevance: ${result.ranking.toFixed(2)}`);
    if (result.context) parts.push(`Context: ${result.context}`);
    parts.push('');
  });
  return parts.join('\n');
}

export function formatCollectionStructure(nodes: OutlineCollectionNode[]): string {
  if (nodes.length === 0) return 'No documents found in this collection.';
  const lines = ['# Collection Structure', ''];
  const walk = (node: OutlineCollectionNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- ${node.title ?? 'Untitled'} (ID: ${node.id ?? ''})`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return lines.join('\n');
}

/**
 * Render an Outline comment body from ProseMirror JSON back to plain markdown.
 *
 * Outline stores comment bodies as ProseMirror documents (a nested tree of
 * `{ type, content, marks, text, attrs }` nodes). The reference implementation
 * this MCP was ported from dumped that JSON verbatim, which is unpleasant to
 * read. This walker handles the shapes Outline actually emits (paragraphs,
 * text with common marks, links, code, blockquote, headings, hard breaks,
 * lists) and produces the same markdown the user typed when they added the
 * comment.
 *
 * If the input isn't a recognizable ProseMirror doc — malformed, empty, or a
 * shape we don't understand yet — returns `null` so the caller can fall back
 * to the raw-JSON display and not silently drop information.
 */
export function renderProseMirror(node: unknown): string | null {
  if (!isPMNode(node)) return null;
  const rendered = renderNode(node);
  const collapsed = rendered.replace(/\n{3,}/g, '\n\n').trim();
  return collapsed.length > 0 ? collapsed : null;
}

type PMMark = { type: string; attrs?: Record<string, unknown> };
type PMNode = {
  type: string;
  text?: string;
  content?: PMNode[];
  marks?: PMMark[];
  attrs?: Record<string, unknown>;
};

function isPMNode(v: unknown): v is PMNode {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

function renderChildren(node: PMNode, sep = ''): string {
  if (!Array.isArray(node.content)) return '';
  return node.content.map(renderNode).join(sep);
}

function renderNode(node: PMNode): string {
  switch (node.type) {
    case 'doc':
      return renderChildren(node, '\n\n');
    case 'paragraph':
      return renderChildren(node);
    case 'text':
      return applyMarks(node.text ?? '', node.marks);
    case 'hard_break':
    case 'hardBreak':
      return '\n';
    case 'heading': {
      const level = clampHeadingLevel(node.attrs?.level);
      return `${'#'.repeat(level)} ${renderChildren(node)}`;
    }
    case 'blockquote':
      return renderChildren(node, '\n\n')
        .split('\n')
        .map(line => (line.length ? `> ${line}` : '>'))
        .join('\n');
    case 'code_block':
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const body = (node.content ?? []).map(c => c.text ?? '').join('');
      return '```' + lang + '\n' + body + '\n```';
    }
    case 'bullet_list':
    case 'bulletList':
      return (node.content ?? []).map(item => `- ${renderNode(item).trimEnd()}`).join('\n');
    case 'ordered_list':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, i) => `${i + 1}. ${renderNode(item).trimEnd()}`)
        .join('\n');
    case 'list_item':
    case 'listItem':
      return renderChildren(node, '\n');
    case 'horizontal_rule':
    case 'horizontalRule':
      return '---';
    default:
      // Unknown node type — recurse so we don't lose text buried inside, but
      // leave rendering shape-neutral to avoid inventing markup.
      return renderChildren(node, '\n');
  }
}

function clampHeadingLevel(v: unknown): number {
  const n = typeof v === 'number' ? v : 1;
  return Math.min(6, Math.max(1, Math.floor(n)));
}

function applyMarks(text: string, marks?: PMMark[]): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const m of marks) {
    switch (m.type) {
      case 'strong':
      case 'bold':
        out = `**${out}**`;
        break;
      case 'em':
      case 'italic':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
      case 'strikethrough':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
        out = href ? `[${out}](${href})` : out;
        break;
      }
      // Unknown marks: leave the text as-is rather than lose it.
    }
  }
  return out;
}

/** Render a comment body, falling back to fenced JSON when we can't parse it. */
function renderCommentBody(data: unknown): string {
  const md = renderProseMirror(data);
  if (md) return md;
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

export function formatComment(comment: OutlineComment): string {
  const user = comment.createdBy?.name ?? 'Unknown User';
  const parts = [`# Comment by ${user}`];
  if (comment.createdAt) parts.push(`Date: ${comment.createdAt}`);
  if (comment.anchorText) parts.push('', `Referencing text: "${comment.anchorText}"`);
  if (comment.data !== undefined && comment.data !== null) {
    parts.push('', 'Comment content:', renderCommentBody(comment.data));
  } else {
    parts.push('', '(No comment content found)');
  }
  return parts.join('\n');
}

export function formatComments(
  comments: OutlineComment[],
  pagination?: OutlinePagination,
  limit = 25,
  offset = 0,
): string {
  if (comments.length === 0) return 'No comments found for this document.';
  const total = pagination?.total ?? comments.length;
  const parts = ['# Document Comments', ''];
  if (pagination) {
    const end = Math.min(offset + comments.length, total);
    parts.push(`Showing comments ${offset + 1}-${end} of ${total} total`);
    parts.push('');
    if (comments.length === limit) {
      parts.push(`Note: Only showing the first batch of comments. Use offset=${offset + limit} to see more comments.`);
      parts.push('');
    }
  }
  comments.forEach((c, idx) => {
    const user = c.createdBy?.name ?? 'Unknown User';
    parts.push(`## ${offset + idx + 1}. Comment by ${user}`);
    parts.push(`ID: ${c.id ?? ''}`);
    if (c.createdAt) parts.push(`Date: ${c.createdAt}`);
    if (c.anchorText) parts.push('', `Referencing text: "${c.anchorText}"`);
    if (c.data !== undefined && c.data !== null) {
      parts.push('', 'Comment content:', renderCommentBody(c.data), '');
    } else {
      parts.push('', '(No comment content found)', '');
    }
  });
  return parts.join('\n');
}

// Match /api/attachments.redirect?id=<uuid> in document text.
const ATTACHMENT_PATTERN = /\/api\/attachments\.redirect\?id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

export function parseAttachmentIds(text: string): { id: string; context: string }[] {
  const results: { id: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    const start = Math.max(0, matchStart - 40);
    const end = Math.min(text.length, matchEnd + 40);
    let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';
    results.push({ id, context: snippet });
  }
  return results;
}

export function formatAttachmentList(
  documentTitle: string,
  attachments: { id: string; context: string }[],
): string {
  if (attachments.length === 0) return `Document '${documentTitle}': No attachments found.`;
  const lines = [`Document '${documentTitle}': ${attachments.length} attachment(s)`, ''];
  attachments.forEach((a, i) => {
    lines.push(`${i + 1}. ID: ${a.id}`);
    lines.push(`   Context: ${a.context}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

// ==== Session + error helpers used by every Outline tool executor ====

export type OutlineToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

/** Extract the OutlineClient from a session, or throw a not-connected UserError. */
export function getOutlineClient(session?: UserSession): OutlineClient {
  if (!session?.outlineAccessToken) {
    throw new UserError('Outline not connected. Visit the dashboard to connect your Outline account.');
  }
  return new OutlineClient(session.outlineAccessToken, session.outlineBaseUrl);
}

/** Translate an API/network error into a `UserError` with the given prefix. */
export function mapOutlineError(prefix: string, error: any, log: OutlineToolLog): never {
  log.error(`${prefix}: ${error?.message ?? error}`);
  if (error?.status === 401 || error?.status === 403) {
    throw new UserError(`${prefix}: not authorized. Check that your Outline token has access.`);
  }
  if (error?.status === 404) {
    throw new UserError(`${prefix}: not found.`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

/**
 * Wrap a tool body with the standard client-fetch + error-mapping pattern.
 * `getOutlineClient` runs BEFORE the callback so a missing token is surfaced
 * verbatim (no double-wrapping via mapOutlineError).
 */
export async function withOutlineClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: OutlineToolLog,
  fn: (client: OutlineClient) => Promise<T>,
): Promise<T> {
  const client = getOutlineClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapOutlineError(prefix, error, log);
  }
}
