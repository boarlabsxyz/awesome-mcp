// src/outline/apiHelpers.ts
// Adapted from https://github.com/Vortiago/mcp-outline@e699cd5d16a983c7bcb4e67c3cf213608df7eeac
// (endpoints and payloads correspond to Outline's public REST API)

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';
import { isPrivateHost } from '../util/baseUrlGuard.js';
import { PRIVATE_ADDRESS, pinnedHttpsRequest } from '../util/pinnedHttps.js';
import { refreshOutlineToken } from './oauthCallback.js';

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
  icon?: string | null;
  color?: string | null;
  fullWidth?: boolean;
  templateId?: string | null;
};

export type OutlineCollection = {
  id: string;
  name?: string;
  description?: string;
  color?: string;
  icon?: string | null;
  archivedAt?: string | null;
};

export type OutlineComment = {
  id: string;
  createdBy?: { name?: string };
  createdAt?: string;
  updatedAt?: string;
  anchorText?: string;
  parentCommentId?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: { name?: string } | null;
  data?: unknown;
};

export type OutlineUser = {
  id: string;
  name?: string;
  email?: string | null;
  role?: string;
  avatarUrl?: string | null;
  lastActiveAt?: string | null;
  createdAt?: string;
  isSuspended?: boolean;
  isAdmin?: boolean;
  isViewer?: boolean;
};

export type OutlineTemplate = {
  id: string;
  title?: string;
  text?: string;
  data?: unknown;
  icon?: string | null;
  collectionId?: string | null;
  updatedAt?: string;
  createdBy?: { name?: string };
};

export type OutlineRevision = {
  id: string;
  documentId?: string;
  title?: string;
  name?: string | null;
  text?: string;
  data?: unknown;
  createdAt?: string;
  createdBy?: { id?: string; name?: string };
  collaborators?: Array<{ id?: string; name?: string }>;
};

/** What attachments.create answers: where and how to send the bytes. */
export type OutlineAttachmentUpload = {
  maxUploadSize?: number;
  /** `post` (multipart form to uploadUrl) or `put` (raw bytes to url). Older servers omit it and use post. */
  mode?: 'post' | 'put';
  uploadUrl?: string;
  form?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  attachment?: { id: string; name?: string; contentType?: string; size?: number; url?: string; documentId?: string | null };
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

/** An upload that did not reach storage: Outline's side, not the caller's, so 502 rather than the REST plane's default 500. */
function storageError(message: string): Error {
  return Object.assign(new Error(message), { status: 502 });
}

export class OutlineClient {
  /** Sends attachment bytes to external storage, connecting only to public addresses. Replaceable in tests, which must not hit the network. */
  static storageRequest = pinnedHttpsRequest;

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
    init?: { redirect?: RequestRedirect; timeoutMs?: number },
  ): Promise<{ data?: T; ok: boolean; status: number; finalUrl?: string; json?: any }> {
    const timeoutMs = init?.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // A FormData body sets its own multipart Content-Type (with the boundary).
    const multipart = body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(multipart ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
        },
        body: multipart ? body : body !== undefined ? JSON.stringify(body) : undefined,
        redirect: init?.redirect ?? 'follow',
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`Outline API ${method} ${path} timed out after ${timeoutMs}ms`);
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

  private async postMultipart(path: string, form: FormData, timeoutMs: number): Promise<any> {
    const res = await this.request('POST', path, form, { timeoutMs });
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
    color?: string;
    fullWidth?: boolean;
    templateId?: string;
  }): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.create', input).then(r => r?.data);
  }

  updateDocument(input: {
    id: string;
    title?: string;
    text?: string;
    append?: boolean;
    /** 'patch' replaces the first occurrence of findText with text (recent Outline only). */
    editMode?: 'patch';
    findText?: string;
    template?: boolean;
    icon?: string | null;
    color?: string | null;
    fullWidth?: boolean;
    publish?: boolean;
  }): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.update', input).then(r => r?.data);
  }

  /** Back to draft; `detach` also takes it out of its collection. */
  unpublishDocument(id: string, detach?: boolean): Promise<OutlineDocument | undefined> {
    return this.post('/api/documents.unpublish', { id, ...(detach !== undefined ? { detach } : {}) }).then(r => r?.data);
  }

  /**
   * Create a document from a file (here: HTML), which runs Outline's importer —
   * remote and base64 images in the HTML are ingested as attachments. Multipart,
   * and given longer than the 30 s JSON timeout because the importer is slow.
   */
  importDocument(input: {
    fileName: string;
    contentType: string;
    content: Uint8Array;
    collectionId?: string;
    parentDocumentId?: string;
    publish?: boolean;
  }): Promise<OutlineDocument | undefined> {
    const form = new FormData();
    form.append('file', new Blob([input.content], { type: input.contentType }), input.fileName);
    if (input.collectionId) form.append('collectionId', input.collectionId);
    if (input.parentDocumentId) form.append('parentDocumentId', input.parentDocumentId);
    if (input.publish !== undefined) form.append('publish', String(input.publish));
    return this.postMultipart('/api/documents.import', form, 120_000).then(r => r?.data);
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
    icon?: string;
  }): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.create', input).then(r => r?.data);
  }

  updateCollection(input: {
    id: string;
    name?: string;
    // Nullable: Outline accepts null on both and applies it as a clear, so the
    // client must be able to carry one through rather than widening it to
    // undefined (which would be dropped and read as "leave it alone").
    description?: string | null;
    color?: string | null;
    icon?: string | null;
  }): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.update', input).then(r => r?.data);
  }

  /** Hides the collection and every document in it; collections.restore undoes it. */
  archiveCollection(id: string, reason?: string): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.archive', { id, ...(reason ? { reason } : {}) }).then(r => r?.data);
  }

  restoreCollection(id: string): Promise<OutlineCollection | undefined> {
    return this.post('/api/collections.restore', { id }).then(r => r?.data);
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
    anchorText?: string;
    anchorPrefix?: string;
    anchorSuffix?: string;
  }): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.create', input).then(r => r?.data);
  }

  updateComment(id: string, text: string): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.update', { id, text }).then(r => r?.data);
  }

  deleteComment(id: string): Promise<{ success?: boolean }> {
    return this.post('/api/comments.delete', { id });
  }

  resolveComment(id: string): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.resolve', { id }).then(r => r?.data);
  }

  unresolveComment(id: string): Promise<OutlineComment | undefined> {
    return this.post('/api/comments.unresolve', { id }).then(r => r?.data);
  }

  // === Users ===

  listUsers(input: {
    query?: string;
    filter?: 'all' | 'invited' | 'active' | 'suspended';
    limit?: number;
    offset?: number;
  }): Promise<{ data: OutlineUser[]; pagination?: OutlinePagination }> {
    return this.post('/api/users.list', {
      ...(input.query ? { query: input.query } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    }).then(r => ({ data: (r?.data ?? []) as OutlineUser[], pagination: r?.pagination }));
  }

  getUser(id: string): Promise<OutlineUser | undefined> {
    return this.post('/api/users.info', { id }).then(r => r?.data);
  }

  // === Templates ===

  listTemplates(input: {
    query?: string;
    collectionId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: OutlineTemplate[]; pagination?: OutlinePagination }> {
    return this.post('/api/templates.list', {
      ...(input.query ? { query: input.query } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    }).then(r => ({ data: (r?.data ?? []) as OutlineTemplate[], pagination: r?.pagination }));
  }

  getTemplate(id: string): Promise<OutlineTemplate | undefined> {
    return this.post('/api/templates.info', { id }).then(r => r?.data);
  }

  // === Revisions ===

  /** Newest first. Listed revisions carry no body; read one with getRevision. */
  listRevisions(input: { documentId: string; limit?: number; offset?: number }): Promise<{ data: OutlineRevision[]; pagination?: OutlinePagination }> {
    return this.post('/api/revisions.list', {
      documentId: input.documentId,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
      sort: 'createdAt',
      direction: 'DESC',
    }).then(r => ({ data: (r?.data ?? []) as OutlineRevision[], pagination: r?.pagination }));
  }

  getRevision(id: string): Promise<OutlineRevision | undefined> {
    return this.post('/api/revisions.info', { id }).then(r => r?.data);
  }

  // === Attachments ===

  /** Create the attachment record and get the upload instructions. Uploads nothing by itself. */
  createAttachment(input: { name: string; contentType: string; size: number; documentId?: string }): Promise<OutlineAttachmentUpload | undefined> {
    return this.post('/api/attachments.create', input).then(r => r?.data);
  }

  /**
   * Send the bytes where attachments.create said to. A relative uploadUrl is
   * Outline's own local storage (/api/files.create) and takes our bearer; an
   * absolute one is a presigned cloud URL and must NOT get it. An absolute URL
   * pointing at a private address is refused: the address comes from the
   * (self-hosted) server's answer, and following it blindly would let it aim our
   * egress at internal hosts. The check runs in the connection's own DNS lookup
   * (pinnedHttpsRequest), so a name cannot answer public for the check and
   * private for the connection. Every failure carries status 502 (413 for a
   * size refusal), so the REST plane does not answer 500.
   */
  async uploadAttachmentBytes(upload: OutlineAttachmentUpload, bytes: Uint8Array, contentType: string, fileName: string): Promise<void> {
    const mode = upload.mode ?? (upload.url && !upload.uploadUrl ? 'put' : 'post');
    const target = mode === 'put' ? upload.url : upload.uploadUrl;
    if (!target) throw storageError('Outline returned no upload URL for the attachment.');
    const local = target.startsWith('/');
    const url = local ? `${this.baseUrl}${target}` : target;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw storageError(`Outline returned an upload URL that is not a URL: ${target.slice(0, 100)}`); }
    const unreachable = () => storageError(`Outline's file storage (${parsed.origin}) is not reachable from here: uploads need storage on a public https address. `
      + 'A self-hosted Outline with private storage (e.g. MinIO on an internal network) cannot take uploads through this connector.');
    if (!local && (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname))) throw unreachable();
    const auth: Record<string, string> = local ? { Authorization: `Bearer ${this.token}` } : {};
    let body: BodyInit;
    let headers: Record<string, string>;
    if (mode === 'put') {
      body = new Blob([bytes], { type: contentType });
      headers = { ...auth, ...(upload.headers ?? { 'Content-Type': contentType }) };
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.form ?? {})) form.append(k, String(v));
      form.append('file', new Blob([bytes], { type: contentType }), fileName);
      body = form;
      headers = { ...auth };
    }
    const method = mode === 'put' ? 'PUT' : 'POST';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      let res: Response;
      try {
        res = local
          ? await fetch(url, { method, headers, body, redirect: 'error', signal: controller.signal })
          : await OutlineClient.storageRequest(parsed, { method, headers, body, signal: controller.signal });
      } catch (err: any) {
        if (err?.code === PRIVATE_ADDRESS) throw unreachable();
        if (controller.signal.aborted) throw storageError(`The attachment upload to ${parsed.origin} did not finish within 120 s.`);
        throw storageError(`Could not reach ${local ? 'Outline' : "Outline's file storage"} (${parsed.origin}) to upload the attachment: ${err?.message || err}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err: any = new Error(`Attachment upload failed: ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status === 413 ? 413 : 502;
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

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
  if (comment.resolvedAt) parts.push(`Resolved: ${comment.resolvedAt}${comment.resolvedBy?.name ? ` by ${comment.resolvedBy.name}` : ''}`);
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
    if (c.resolvedAt) parts.push(`Resolved: ${c.resolvedAt}`);
    if (c.anchorText) parts.push('', `Referencing text: "${c.anchorText}"`);
    if (c.data !== undefined && c.data !== null) {
      parts.push('', 'Comment content:', renderCommentBody(c.data), '');
    } else {
      parts.push('', '(No comment content found)', '');
    }
  });
  return parts.join('\n');
}

/** "Showing 1-25", plus the next offset when the page came back full. */
function pageLine(count: number, pagination: OutlinePagination | undefined, limit: number, offset: number): string[] {
  const out = [`Showing ${offset + 1}-${offset + count}${pagination?.total !== undefined ? ` of ${pagination.total}` : ''}`];
  if (count === limit) out.push(`More may be available. Use offset=${offset + limit} to see more.`);
  return out;
}

export function formatUsers(users: OutlineUser[], pagination: OutlinePagination | undefined, limit = 25, offset = 0): string {
  if (users.length === 0) return offset > 0 ? 'No more users.' : 'No users found.';
  const parts = ['# Users', '', ...pageLine(users.length, pagination, limit, offset), ''];
  users.forEach((u, i) => {
    parts.push(`## ${offset + i + 1}. ${u.name ?? 'Unnamed'}`, ...formatUserFields(u), '');
  });
  return parts.join('\n');
}

export function formatUser(u: OutlineUser): string {
  return [`# ${u.name ?? 'Unnamed'}`, ...formatUserFields(u)].join('\n');
}

// Email is only returned to callers allowed to see it (admins, or per the
// workspace setting); say so rather than print a blank that reads as "no email".
function formatUserFields(u: OutlineUser): string[] {
  const lines = [`ID: ${u.id}`];
  lines.push(`Email: ${u.email ?? '(hidden — not visible to this connection)'}`);
  const role = u.role ?? (u.isAdmin ? 'admin' : u.isViewer ? 'viewer' : undefined);
  if (role) lines.push(`Role: ${role}`);
  if (u.isSuspended) lines.push('Status: suspended');
  if (u.lastActiveAt) lines.push(`Last active: ${u.lastActiveAt}`);
  if (u.createdAt) lines.push(`Joined: ${u.createdAt}`);
  return lines;
}

export function formatTemplates(templates: OutlineTemplate[], pagination: OutlinePagination | undefined, limit = 25, offset = 0): string {
  if (templates.length === 0) return offset > 0 ? 'No more templates.' : 'No templates found.';
  const parts = ['# Templates', '', ...pageLine(templates.length, pagination, limit, offset), ''];
  templates.forEach((t, i) => {
    parts.push(`## ${offset + i + 1}. ${t.icon ? `${t.icon} ` : ''}${t.title ?? 'Untitled'}`, `ID: ${t.id}`);
    parts.push(t.collectionId ? `Collection: ${t.collectionId}` : 'Scope: workspace-wide');
    if (t.updatedAt) parts.push(`Last Updated: ${t.updatedAt}`);
    parts.push('');
  });
  return parts.join('\n');
}

/** Markdown body of a template or revision: `text` when Outline sends it, else the ProseMirror `data` rendered. */
export function bodyMarkdown(item: { text?: string; data?: unknown }): string {
  if (typeof item.text === 'string') return item.text;
  return renderProseMirror(item.data) ?? '';
}

export function formatTemplate(t: OutlineTemplate): string {
  const lines = [`# ${t.icon ? `${t.icon} ` : ''}${t.title ?? 'Untitled'}`, `ID: ${t.id}`];
  lines.push(t.collectionId ? `Collection: ${t.collectionId}` : 'Scope: workspace-wide');
  lines.push('', bodyMarkdown(t) || '(empty template)');
  return lines.join('\n');
}

function revisionAuthor(r: OutlineRevision): string {
  const others = (r.collaborators ?? []).map((c) => c.name).filter((n): n is string => Boolean(n) && n !== r.createdBy?.name);
  return `${r.createdBy?.name ?? 'Unknown'}${others.length ? ` (with ${others.join(', ')})` : ''}`;
}

export function formatRevisions(revisions: OutlineRevision[], pagination: OutlinePagination | undefined, limit = 25, offset = 0): string {
  if (revisions.length === 0) return offset > 0 ? 'No more revisions.' : 'No revisions found for this document.';
  const parts = ['# Document History (newest first)', '', ...pageLine(revisions.length, pagination, limit, offset), ''];
  revisions.forEach((r, i) => {
    parts.push(`${offset + i + 1}. ${r.createdAt ?? 'unknown time'} — ${revisionAuthor(r)}${r.name ? ` — "${r.name}"` : ''}`);
    parts.push(`   Revision ID: ${r.id}`);
  });
  return parts.join('\n');
}

/** Cap on the line-diff table (old lines x new lines); past it the diff is summarised. */
const DIFF_CELL_LIMIT = 4_000_000;
/** Cap on diff lines printed. */
const DIFF_OUTPUT_LIMIT = 400;

/**
 * Line diff between two markdown bodies: `-` removed, `+` added, unchanged runs
 * collapsed. LCS over lines, which is exact but quadratic, so very long bodies
 * get counts only. Outline has no diff endpoint; this is computed here.
 */
export function diffLines(before: string, after: string): { text: string; added: number; removed: number; summarized: boolean } {
  if (before === after) return { text: 'No differences.', added: 0, removed: 0, summarized: false };
  const allA = before.split('\n');
  const allB = after.split('\n');
  // Common head and tail are unchanged by definition, so only the middle needs
  // the quadratic table — a small edit to a long document stays exact.
  let pre = 0;
  while (pre < allA.length && pre < allB.length && allA[pre] === allB[pre]) pre++;
  let post = 0;
  while (post < allA.length - pre && post < allB.length - pre && allA[allA.length - 1 - post] === allB[allB.length - 1 - post]) post++;
  const a = allA.slice(pre, allA.length - post);
  const b = allB.slice(pre, allB.length - post);
  if (a.length * b.length > DIFF_CELL_LIMIT) {
    const inA = new Set(a);
    const inB = new Set(b);
    const added = b.filter((l) => !inA.has(l)).length;
    const removed = a.filter((l) => !inB.has(l)).length;
    return { text: `Too many changed lines to diff line by line (${a.length} old vs ${b.length} new). About ${added} line(s) added and ${removed} removed.`, added, removed, summarized: true };
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..], as one flat array.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops: Array<[' ' | '-' | '+', string]> = allA.slice(0, pre).map((l) => [' ', l] as [' ', string]);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  for (const l of allA.slice(allA.length - post)) ops.push([' ', l]);

  const added = ops.filter(([k]) => k === '+').length;
  const removed = ops.filter(([k]) => k === '-').length;
  const out: string[] = [];
  const CONTEXT = 2;
  for (let k = 0; k < ops.length; k++) {
    const [kind, line] = ops[k];
    if (kind !== ' ') { out.push(`${kind} ${line}`); continue; }
    const near = ops.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some(([x]) => x !== ' ');
    if (near) { out.push(`  ${line}`); continue; }
    let run = k;
    while (run + 1 < ops.length && ops[run + 1][0] === ' ' && !ops.slice(run + 1, run + 2 + CONTEXT).some(([x]) => x !== ' ')) run++;
    out.push(`  … ${run - k + 1} unchanged line(s)`);
    k = run;
  }
  const truncated = out.length > DIFF_OUTPUT_LIMIT;
  const text = (truncated ? out.slice(0, DIFF_OUTPUT_LIMIT).concat(`… ${out.length - DIFF_OUTPUT_LIMIT} more diff line(s) not shown`) : out).join('\n');
  return { text: added + removed === 0 ? 'No differences.' : text, added, removed, summarized: false };
}

/** The "who and when" line for one side of a comparison. */
export function describeRevision(r: OutlineRevision | 'current'): string {
  if (r === 'current') return 'the current document';
  return `revision ${r.id} (${r.createdAt ?? 'unknown time'}, by ${revisionAuthor(r)})`;
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

/** Refresh proactively this many ms before the access token's stated expiry. */
const OUTLINE_REFRESH_SKEW_MS = 60_000;

// Single-flight guard: collapse concurrent refreshes for the same connection so
// only one rotating refresh_token grant is in flight at a time. Outline rotates
// the refresh token on every use, so two parallel exchanges would invalidate
// each other. Keyed by outlineInstanceId when present; the WeakMap covers the
// (rare) session without a stable instance id by keying on the shared,
// by-reference session object itself.
const inflightOutlineRefreshById = new Map<string, Promise<void>>();
const inflightOutlineRefreshBySession = new WeakMap<UserSession, Promise<void>>();

/**
 * If this is an OAuth Outline session whose access token is at/near expiry,
 * exchange the refresh token for a fresh access token, mutate the (cached,
 * by-reference) session in place, and persist the rotated tokens. Concurrent
 * calls for the same connection share a single in-flight refresh.
 *
 * Best-effort and never throws: on any failure the existing access token is
 * left in place so the tool call still proceeds (and surfaces a normal 401 via
 * mapOutlineError if the token really is dead). No-ops for paste-token sessions
 * (which carry no refresh_token/expiry) and when OAuth client credentials are
 * absent — so the paste-token flow is completely unaffected.
 */
export async function maybeRefreshOutlineToken(
  session: UserSession | undefined,
  log: OutlineToolLog,
): Promise<void> {
  if (!session) return;
  const expiry = session.outlineTokenExpiry;
  // Only OAuth connections carry all of these; anything else skips refresh.
  if (!expiry || !session.outlineRefreshToken || !session.outlineOauthClientId || !session.outlineOauthClientSecret) {
    return;
  }
  if (Date.now() < expiry - OUTLINE_REFRESH_SKEW_MS) return;

  // Reuse an in-flight refresh for this connection if one is already running so
  // concurrent tool calls await the same request instead of each POSTing (and
  // invalidating) the rotating refresh token.
  const instanceId = session.outlineInstanceId;
  const existing = instanceId
    ? inflightOutlineRefreshById.get(instanceId)
    : inflightOutlineRefreshBySession.get(session);
  if (existing) {
    await existing;
    return;
  }

  const refresh = performOutlineRefresh(session, log).finally(() => {
    if (instanceId) inflightOutlineRefreshById.delete(instanceId);
    else inflightOutlineRefreshBySession.delete(session);
  });
  if (instanceId) inflightOutlineRefreshById.set(instanceId, refresh);
  else inflightOutlineRefreshBySession.set(session, refresh);
  await refresh;
}

/**
 * Perform the refresh_token exchange, rotate the session tokens in place, and
 * persist the rotated pair. Never throws (best-effort) so single-flight
 * awaiters always resolve cleanly.
 */
async function performOutlineRefresh(session: UserSession, log: OutlineToolLog): Promise<void> {
  const refreshToken = session.outlineRefreshToken;
  const clientId = session.outlineOauthClientId;
  const clientSecret = session.outlineOauthClientSecret;
  if (!refreshToken || !clientId || !clientSecret) return;
  const baseUrl = (session.outlineBaseUrl || process.env.OUTLINE_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return;

  const result = await refreshOutlineToken({
    tokenUrl: `${baseUrl}/oauth/token`,
    refreshToken,
    clientId,
    clientSecret,
  });
  if (!result.ok) {
    log.error(`Outline token refresh failed (${result.status}); using existing token. ${result.logMessage}`);
    return;
  }

  // Rotate in place so the cached session and subsequent tool calls see the new
  // token. Outline rotates the refresh token on each use, so prefer whichever it
  // returned (falling back to the current one only if it omitted a new one).
  const newRefresh = result.refreshToken ?? refreshToken;
  const newExpiry = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
  session.outlineAccessToken = result.accessToken;
  session.outlineRefreshToken = newRefresh;
  session.outlineTokenExpiry = newExpiry;

  // Persist so a cold cache (or another process) reads the rotated tokens. The
  // dynamic import keeps the connection store (and its db deps) out of the
  // module-load path for unit tests that never trigger a refresh.
  const instanceId = session.outlineInstanceId;
  if (instanceId) {
    try {
      const { updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
      await updateMcpInstanceProviderTokens(instanceId, {
        access_token: result.accessToken,
        refresh_token: newRefresh,
        expiry_date: newExpiry,
        baseUrl: session.outlineBaseUrl,
      });
    } catch (err: any) {
      log.error(`Failed to persist refreshed Outline tokens for ${instanceId}: ${err?.message ?? err}`);
    }
  }
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
  // Proactively refresh an expiring OAuth access token before building the
  // client (no-op for paste-token sessions). Runs before getOutlineClient so a
  // missing-token error is still surfaced verbatim by getOutlineClient.
  await maybeRefreshOutlineToken(session, log);
  const client = getOutlineClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapOutlineError(prefix, error, log);
  }
}
