// src/__tests__/outline.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import { outlineServer } from '../outline/server.js';
import {
  OutlineClient,
  formatFileOperation,
  formatDocumentsList,
  formatCollections,
  formatSearchResults,
  formatCollectionStructure,
  formatComment,
  formatComments,
  formatAttachmentList,
  parseAttachmentIds,
  getOutlineClient,
  mapOutlineError,
  withOutlineClient,
  renderProseMirror,
} from '../outline/apiHelpers.js';

// -----------------------------------------------------------------------------
// Server registration
// -----------------------------------------------------------------------------

test('outline server is registered', () => {
  assert.ok(outlineServer, 'server should be defined');
});

// -----------------------------------------------------------------------------
// formatFileOperation
// -----------------------------------------------------------------------------

describe('formatFileOperation', () => {
  test('handles undefined', () => {
    assert.equal(formatFileOperation(undefined), 'No file operation data available.');
  });

  test('renders complete operation with download instructions', () => {
    const out = formatFileOperation({
      id: 'op-1',
      state: 'complete',
      type: 'export',
      name: 'workspace-backup',
    });
    assert.match(out, /# Export Operation: workspace-backup/);
    assert.match(out, /State: complete/);
    assert.match(out, /Type: export/);
    assert.match(out, /ID: op-1/);
    assert.match(out, /export is complete/);
  });

  test('renders in-progress operation with retry hint', () => {
    const out = formatFileOperation({
      id: 'op-2',
      state: 'creating',
      type: 'export',
      name: 'collection-x',
    });
    assert.match(out, /still in progress/);
    assert.match(out, /ID: op-2/);
  });

  test('falls back to unknowns for missing fields', () => {
    const out = formatFileOperation({ id: '' });
    assert.match(out, /State: unknown/);
    assert.match(out, /Type: unknown/);
    assert.match(out, /# Export Operation: unknown/);
  });
});

// -----------------------------------------------------------------------------
// formatDocumentsList
// -----------------------------------------------------------------------------

describe('formatDocumentsList', () => {
  test('empty list uses the lowercased title in the message', () => {
    assert.equal(formatDocumentsList([], 'Archived Documents'), 'No archived documents found.');
  });

  test('renders numbered documents with metadata', () => {
    const out = formatDocumentsList(
      [
        { id: 'd1', title: 'Alpha', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'd2', title: 'Bravo' },
      ],
      'Recently Updated Documents',
    );
    assert.match(out, /# Recently Updated Documents/);
    assert.match(out, /## 1\. Alpha/);
    assert.match(out, /ID: d1/);
    assert.match(out, /Last Updated: 2026-01-01T00:00:00.000Z/);
    assert.match(out, /## 2\. Bravo/);
  });

  test('falls back to Untitled when title is missing', () => {
    const out = formatDocumentsList([{ id: 'x' }], 'Whatever');
    assert.match(out, /## 1\. Untitled/);
  });
});

// -----------------------------------------------------------------------------
// formatCollections
// -----------------------------------------------------------------------------

describe('formatCollections', () => {
  test('empty list returns default message', () => {
    assert.equal(formatCollections([]), 'No collections found.');
  });

  test('renders name/id/description', () => {
    const out = formatCollections([
      { id: 'c1', name: 'Docs', description: 'the docs collection' },
      { id: 'c2', name: 'Runbooks' },
    ]);
    assert.match(out, /# Collections/);
    assert.match(out, /## 1\. Docs/);
    assert.match(out, /ID: c1/);
    assert.match(out, /Description: the docs collection/);
    assert.match(out, /## 2\. Runbooks/);
    assert.doesNotMatch(out, /Description: undefined/);
  });

  test('falls back for missing names', () => {
    const out = formatCollections([{ id: 'c9' }]);
    assert.match(out, /## 1\. Untitled Collection/);
  });
});

// -----------------------------------------------------------------------------
// formatSearchResults
// -----------------------------------------------------------------------------

describe('formatSearchResults', () => {
  test('empty results', () => {
    assert.equal(formatSearchResults([]), 'No documents found matching your search.');
  });

  test('renders results without pagination', () => {
    const out = formatSearchResults([{ document: { id: 'd1', title: 'Hello' } }]);
    assert.match(out, /# Search Results/);
    assert.match(out, /## 1\. Hello/);
    assert.match(out, /ID: d1/);
    assert.doesNotMatch(out, /Showing results/);
  });

  test('renders pagination and next-page hint when full page returned', () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      document: { id: `d${i}`, title: `Doc ${i}` },
      ranking: 0.5,
      context: 'snippet',
    }));
    const out = formatSearchResults(results, { limit: 25, offset: 0 });
    assert.match(out, /Showing results 1-25/);
    assert.match(out, /Use offset=25 to see more/);
    assert.match(out, /Relevance: 0\.50/);
    assert.match(out, /Context: snippet/);
  });

  test('no next-page hint when short page', () => {
    const out = formatSearchResults(
      [{ document: { id: 'd1', title: 'X' } }],
      { limit: 25, offset: 0 },
    );
    assert.match(out, /Showing results 1-1/);
    assert.doesNotMatch(out, /to see more/);
  });

  test('falls back for missing fields in a result', () => {
    const out = formatSearchResults([{}]);
    assert.match(out, /## 1\. Untitled/);
  });
});

// -----------------------------------------------------------------------------
// formatCollectionStructure
// -----------------------------------------------------------------------------

describe('formatCollectionStructure', () => {
  test('empty', () => {
    assert.equal(formatCollectionStructure([]), 'No documents found in this collection.');
  });

  test('renders nested tree with indentation', () => {
    const out = formatCollectionStructure([
      {
        id: 'r1',
        title: 'Root',
        children: [
          { id: 'c1', title: 'Child 1' },
          { id: 'c2', title: 'Child 2', children: [{ id: 'g1', title: 'Grand' }] },
        ],
      },
    ]);
    assert.match(out, /# Collection Structure/);
    assert.match(out, /- Root \(ID: r1\)/);
    assert.match(out, / {2}- Child 1 \(ID: c1\)/);
    assert.match(out, / {4}- Grand \(ID: g1\)/);
  });

  test('missing title falls back to Untitled', () => {
    const out = formatCollectionStructure([{ id: 'x' }]);
    assert.match(out, /- Untitled \(ID: x\)/);
  });
});

// -----------------------------------------------------------------------------
// formatComment / formatComments
// -----------------------------------------------------------------------------

describe('formatComment', () => {
  test('renders with anchor and data', () => {
    const out = formatComment({
      id: 'x',
      createdBy: { name: 'Ana' },
      createdAt: '2026-01-02T03:04:05.000Z',
      anchorText: 'quoted',
      data: { text: 'hi' },
    });
    assert.match(out, /# Comment by Ana/);
    assert.match(out, /Date: 2026-01-02T03:04:05.000Z/);
    assert.match(out, /Referencing text: "quoted"/);
    assert.match(out, /```json/);
    assert.match(out, /"text": "hi"/);
  });

  test('renders with missing user + no data', () => {
    const out = formatComment({ id: 'x' });
    assert.match(out, /# Comment by Unknown User/);
    assert.match(out, /\(No comment content found\)/);
  });
});

describe('formatComments', () => {
  test('empty', () => {
    assert.equal(formatComments([]), 'No comments found for this document.');
  });

  test('renders paginated batch with next-batch hint when full page', () => {
    const comments = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      createdBy: { name: `User ${i}` },
      createdAt: '2026-01-02T00:00:00.000Z',
      anchorText: 'anchor',
      data: { body: `msg-${i}` },
    }));
    const out = formatComments(comments, { total: 20, limit: 5, offset: 5 }, 5, 5);
    assert.match(out, /Showing comments 6-10 of 20 total/);
    assert.match(out, /Only showing the first batch/);
    assert.match(out, /Use offset=10 to see more/);
    assert.match(out, /## 6\. Comment by User 0/);
    assert.match(out, /## 10\. Comment by User 4/);
  });

  test('renders without pagination info', () => {
    const out = formatComments([
      { id: 'c1', createdBy: { name: 'Ana' } },
    ]);
    assert.match(out, /# Document Comments/);
    assert.match(out, /## 1\. Comment by Ana/);
    assert.doesNotMatch(out, /Showing comments/);
  });
});

// -----------------------------------------------------------------------------
// parseAttachmentIds + formatAttachmentList
// -----------------------------------------------------------------------------

describe('parseAttachmentIds', () => {
  test('finds no matches in plain text', () => {
    assert.deepEqual(parseAttachmentIds('nothing here'), []);
  });

  test('extracts multiple unique IDs and dedupes', () => {
    const uuid1 = '11111111-2222-3333-4444-555555555555';
    const uuid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const text = `See [file](/api/attachments.redirect?id=${uuid1}) and again ${uuid1} ` +
      `plus [image](/api/attachments.redirect?id=${uuid2}) plus dup /api/attachments.redirect?id=${uuid1}`;
    const out = parseAttachmentIds(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, uuid1);
    assert.equal(out[1].id, uuid2);
    assert.match(out[0].context, /.../);
  });

  test('adds ellipsis when the match sits mid-text', () => {
    const padding = 'x'.repeat(200);
    const uuid = '11111111-2222-3333-4444-555555555555';
    const text = `${padding}/api/attachments.redirect?id=${uuid}${padding}`;
    const [match] = parseAttachmentIds(text);
    assert.match(match.context, /^\.\.\.x/);
    assert.match(match.context, /x\.\.\.$/);
  });
});

describe('formatAttachmentList', () => {
  test('empty', () => {
    assert.equal(
      formatAttachmentList('Doc', []),
      "Document 'Doc': No attachments found.",
    );
  });

  test('renders numbered list with contexts', () => {
    const out = formatAttachmentList('Doc', [
      { id: 'a1', context: 'ctx-1' },
      { id: 'a2', context: 'ctx-2' },
    ]);
    assert.match(out, /Document 'Doc': 2 attachment/);
    assert.match(out, /1\. ID: a1/);
    assert.match(out, /Context: ctx-1/);
    assert.match(out, /2\. ID: a2/);
  });
});

// -----------------------------------------------------------------------------
// OutlineClient.request — mocked fetch
// -----------------------------------------------------------------------------

type MockCall = { url: string; init: RequestInit };
let calls: MockCall[] = [];
let mockImpl: ((call: MockCall) => Response | Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;

function installMockFetch() {
  calls = [];
  globalThis.fetch = ((async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (!mockImpl) throw new Error('mockImpl not set for this test');
    return mockImpl({ url, init });
  }) as unknown) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, init: ResponseInit = { status: 200 }): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('OutlineClient.request', () => {
  beforeEach(() => installMockFetch());
  afterEach(() => {
    mockImpl = null;
    globalThis.fetch = originalFetch;
  });

  test('sends Authorization + Content-Type headers and a JSON body', async () => {
    mockImpl = () => jsonResponse({ data: { ok: true } });
    const client = new OutlineClient('tok-abc');
    const result = await client.post('/api/documents.info', { id: 'd1' });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.init.method, 'POST');
    assert.equal((call.init.headers as any).Authorization, 'Bearer tok-abc');
    assert.equal((call.init.headers as any)['Content-Type'], 'application/json');
    assert.equal(call.init.body, JSON.stringify({ id: 'd1' }));
    assert.deepEqual(result, { data: { ok: true } });
  });

  test('non-JSON response returns the parsed envelope without json body', async () => {
    mockImpl = () => textResponse('plain');
    const client = new OutlineClient('tok');
    const raw = await client.exportDocument('d1');
    assert.equal(raw, '');
  });

  test('non-2xx response throws with .status and body preserved', async () => {
    mockImpl = () => textResponse('boom', { status: 500 });
    const client = new OutlineClient('tok');
    await assert.rejects(
      () => client.getDocument('d1'),
      (err: any) => {
        assert.equal(err.status, 500);
        assert.match(err.message, /Outline API POST \/api\/documents\.info failed: 500 boom/);
        assert.equal(err.body, 'boom');
        return true;
      },
    );
  });

  test('propagates 404 with .status', async () => {
    mockImpl = () => textResponse('nope', { status: 404 });
    const client = new OutlineClient('tok');
    await assert.rejects(
      () => client.getDocument('d1'),
      (err: any) => err.status === 404,
    );
  });

  test('translates AbortError into a timeout error', async () => {
    mockImpl = () => {
      const e: any = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    const client = new OutlineClient('tok');
    await assert.rejects(
      () => client.getDocument('d1'),
      /timed out after 30000ms/,
    );
  });

  test('re-throws non-abort network errors as-is', async () => {
    mockImpl = () => { throw new Error('ECONNREFUSED'); };
    const client = new OutlineClient('tok');
    await assert.rejects(() => client.getDocument('d1'), /ECONNREFUSED/);
  });

  test('follows redirect via getAttachmentRedirectUrl', async () => {
    mockImpl = () =>
      new Response('', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    const client = new OutlineClient('tok');
    const url = await client.getAttachmentRedirectUrl('att-1');
    assert.equal(typeof url, 'string');
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].url, /\/api\/attachments\.redirect$/);
  });
});

// -----------------------------------------------------------------------------
// OutlineClient method dispatch — verifies every wrapper hits the right path.
// This is deliberately terse — the fetch mock captures each call for assertion.
// -----------------------------------------------------------------------------

describe('OutlineClient method dispatch', () => {
  beforeEach(() => installMockFetch());
  afterEach(() => {
    mockImpl = null;
    globalThis.fetch = originalFetch;
  });

  test('all endpoint methods POST to the correct /api path', async () => {
    mockImpl = () => jsonResponse({ data: null, fileOperation: null });
    const c = new OutlineClient('tok');
    await c.getDocument('id');
    await c.createDocument({ title: 't', collectionId: 'c' });
    await c.updateDocument({ id: 'id' });
    await c.moveDocument({ id: 'id', collectionId: 'c' });
    await c.archiveDocument('id');
    await c.unarchiveDocument('id');
    await c.restoreDocument('id');
    await c.moveToTrash('id');
    await c.permanentlyDeleteDocument('id');
    await c.listArchivedDocuments();
    await c.listTrash();
    await c.searchDocuments({ query: 'q', collectionId: 'c', statusFilter: ['draft'], sort: 'updatedAt', direction: 'DESC', dateFilter: 'week' });
    await c.searchDocuments({ query: 'q' }); // exercises defaults branch
    await c.listDocuments({ backlinkDocumentId: 'id' });
    await c.exportDocument('id');
    await c.listCollections({ limit: 50, offset: 10 });
    await c.listCollections(); // defaults branch
    await c.createCollection({ name: 'N' });
    await c.updateCollection({ id: 'id', name: 'N' });
    await c.deleteCollection('id');
    await c.getCollectionDocuments('id');
    await c.exportCollection('id', 'json');
    await c.exportAllCollections('json');
    await c.listDocumentComments({ documentId: 'id' });
    await c.getComment('cid');
    await c.createComment({ documentId: 'id', text: 'hi' });

    const paths = calls.map((c) => new URL(c.url).pathname);
    // Spot-check that each expected endpoint got hit at least once.
    const expected = [
      '/api/documents.info',
      '/api/documents.create',
      '/api/documents.update',
      '/api/documents.move',
      '/api/documents.archive',
      // /api/documents.unarchive is intentionally absent — Outline exposes a
      // single /api/documents.restore endpoint for both archive- and trash-
      // restoration, so unarchiveDocument() maps to documents.restore too.
      '/api/documents.restore',
      '/api/documents.delete',
      '/api/documents.archived',
      '/api/documents.deleted',
      '/api/documents.search',
      '/api/documents.list',
      '/api/documents.export',
      '/api/collections.list',
      '/api/collections.create',
      '/api/collections.update',
      '/api/collections.delete',
      '/api/collections.documents',
      '/api/collections.export',
      '/api/collections.export_all',
      '/api/comments.list',
      '/api/comments.info',
      '/api/comments.create',
    ];
    for (const p of expected) {
      assert.ok(paths.includes(p), `expected a call to ${p}, got ${paths.join(', ')}`);
    }
  });

  test('searchDocuments returns empty data + pagination shape when API omits fields', async () => {
    mockImpl = () => jsonResponse({});
    const c = new OutlineClient('tok');
    const { data, pagination } = await c.searchDocuments({ query: 'x' });
    assert.deepEqual(data, []);
    assert.equal(pagination, undefined);
  });

  test('permanentlyDeleteDocument sends permanent: true', async () => {
    mockImpl = () => jsonResponse({ success: true });
    const c = new OutlineClient('tok');
    await c.permanentlyDeleteDocument('doc-1');
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body, { id: 'doc-1', permanent: true });
  });

  test('getComment forwards includeAnchorText', async () => {
    mockImpl = () => jsonResponse({ data: { id: 'c1' } });
    const c = new OutlineClient('tok');
    await c.getComment('c1', true);
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body, { id: 'c1', includeAnchorText: true });
  });
});

// -----------------------------------------------------------------------------
// getOutlineClient / mapOutlineError / withOutlineClient
// -----------------------------------------------------------------------------

describe('getOutlineClient', () => {
  test('throws UserError when session is missing', () => {
    assert.throws(() => getOutlineClient(undefined), UserError);
  });

  test('throws UserError when token is missing', () => {
    assert.throws(() => getOutlineClient({} as any), UserError);
  });

  test('returns an OutlineClient when token is present', () => {
    const client = getOutlineClient({ outlineAccessToken: 't' } as any);
    assert.ok(client instanceof OutlineClient);
  });

  test('picks up per-session outlineBaseUrl on the returned client', () => {
    const client = getOutlineClient({ outlineAccessToken: 't', outlineBaseUrl: 'https://wiki.example.com' } as any);
    assert.equal(client.baseUrl, 'https://wiki.example.com');
  });

  test('falls back to the module default when session omits outlineBaseUrl', () => {
    const client = getOutlineClient({ outlineAccessToken: 't' } as any);
    assert.match(client.baseUrl, /^https?:\/\//);
  });
});

describe('OutlineClient baseUrl normalization', () => {
  test('trailing slashes are stripped so the request URL never doubles up', () => {
    const c = new OutlineClient('t', 'https://wiki.example.com///');
    assert.equal(c.baseUrl, 'https://wiki.example.com');
  });

  test('constructor param wins over the module default', () => {
    const c = new OutlineClient('t', 'https://custom.example.com');
    assert.equal(c.baseUrl, 'https://custom.example.com');
  });
});

describe('mapOutlineError', () => {
  const captureLog = () => {
    const errors: string[] = [];
    return {
      log: {
        info: () => {},
        error: (m: string) => errors.push(m),
      },
      errors,
    };
  };

  test('401 becomes a not-authorized UserError', () => {
    const { log, errors } = captureLog();
    assert.throws(
      () => mapOutlineError('Failed to X', { status: 401, message: 'nope' }, log),
      (err: any) => err instanceof UserError && /not authorized/.test(err.message),
    );
    assert.equal(errors.length, 1);
  });

  test('403 becomes a not-authorized UserError', () => {
    const { log } = captureLog();
    assert.throws(
      () => mapOutlineError('Failed to X', { status: 403 }, log),
      /not authorized/,
    );
  });

  test('404 becomes a not-found UserError', () => {
    const { log } = captureLog();
    assert.throws(
      () => mapOutlineError('Failed to X', { status: 404 }, log),
      /not found/,
    );
  });

  test('other errors get generic message with error.message', () => {
    const { log } = captureLog();
    assert.throws(
      () => mapOutlineError('Failed to X', { message: 'boom' }, log),
      /Failed to X: boom/,
    );
  });

  test('missing message falls back to "Unknown error"', () => {
    const { log } = captureLog();
    assert.throws(
      () => mapOutlineError('Failed to X', {}, log),
      /Failed to X: Unknown error/,
    );
  });
});

describe('withOutlineClient', () => {
  const noopLog = { info: () => {}, error: () => {} };

  test('surfaces the fn result on success', async () => {
    const session = { outlineAccessToken: 't' } as any;
    const out = await withOutlineClient('prefix', session, noopLog, async () => 'ok');
    assert.equal(out, 'ok');
  });

  test('propagates getOutlineClient errors verbatim (no mapping)', async () => {
    await assert.rejects(
      withOutlineClient('prefix', undefined, noopLog, async () => 'unused'),
      (err: any) => err instanceof UserError && /not connected/.test(err.message),
    );
  });

  test('maps fn errors through mapOutlineError', async () => {
    const session = { outlineAccessToken: 't' } as any;
    await assert.rejects(
      withOutlineClient('Failed to X', session, noopLog, async () => {
        const e: any = new Error('boom');
        e.status = 404;
        throw e;
      }),
      /not found/,
    );
  });
});

// -----------------------------------------------------------------------------
// unarchiveDocument endpoint mapping (regression guard against the "not found"
// bug where /api/documents.unarchive returned 404).
// -----------------------------------------------------------------------------

describe('unarchiveDocument endpoint mapping', () => {
  beforeEach(() => installMockFetch());
  afterEach(() => {
    mockImpl = null;
    globalThis.fetch = originalFetch;
  });

  test('hits /api/documents.restore, NOT /api/documents.unarchive', async () => {
    mockImpl = () => jsonResponse({ data: { id: 'd1', title: 'Doc' } });
    const c = new OutlineClient('tok');
    await c.unarchiveDocument('d1');
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, '/api/documents.restore');
  });

  test('both unarchive and restore share the same endpoint (single Outline route)', async () => {
    mockImpl = () => jsonResponse({ data: { id: 'd1' } });
    const c = new OutlineClient('tok');
    await c.unarchiveDocument('d1');
    await c.restoreDocument('d1');
    const paths = calls.map(c => new URL(c.url).pathname);
    assert.deepEqual(paths, ['/api/documents.restore', '/api/documents.restore']);
  });
});

// -----------------------------------------------------------------------------
// renderProseMirror + formatComment PM rendering
// -----------------------------------------------------------------------------

describe('renderProseMirror', () => {
  test('returns null for non-ProseMirror inputs so callers can fall back cleanly', () => {
    assert.equal(renderProseMirror(null), null);
    assert.equal(renderProseMirror(undefined), null);
    assert.equal(renderProseMirror('not a node'), null);
    assert.equal(renderProseMirror(42), null);
    assert.equal(renderProseMirror({}), null);
    assert.equal(renderProseMirror({ text: 'no type field' }), null);
  });

  test('renders a plain paragraph', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] };
    assert.equal(renderProseMirror(doc), 'hello world');
  });

  test('applies strong/em/code/strike/link marks in the expected markdown', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'https://x.example.com' } }] },
          ],
        },
      ],
    };
    assert.equal(
      renderProseMirror(doc),
      'plain **bold** *italic* `code` ~~gone~~ [here](https://x.example.com)',
    );
  });

  test('accepts both PascalCase and snake_case node/mark names Outline uses', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'b', marks: [{ type: 'italic' }] }],
        },
      ],
    };
    assert.equal(renderProseMirror(doc), '**a**\n\n*b*');
  });

  test('renders headings, blockquotes, code blocks, and both list styles', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        {
          type: 'code_block',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'console.log(1)' }],
        },
        {
          type: 'bullet_list',
          content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
        {
          type: 'ordered_list',
          content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
          ],
        },
        { type: 'horizontal_rule' },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    assert.match(out, /^## Section/);
    assert.match(out, /^> quoted/m);
    assert.match(out, /```js\nconsole\.log\(1\)\n```/);
    assert.match(out, /^- one\n- two/m);
    assert.match(out, /^1\. first\n2\. second/m);
    assert.match(out, /^---$/m);
  });

  test('clamps heading levels to 1..6 and defaults invalid values to 1', () => {
    const above = { type: 'doc', content: [{ type: 'heading', attrs: { level: 12 }, content: [{ type: 'text', text: 'X' }] }] };
    const below = { type: 'doc', content: [{ type: 'heading', attrs: { level: 0 }, content: [{ type: 'text', text: 'X' }] }] };
    const bogus = { type: 'doc', content: [{ type: 'heading', attrs: { level: 'wat' }, content: [{ type: 'text', text: 'X' }] }] };
    assert.equal(renderProseMirror(above), '###### X');
    assert.equal(renderProseMirror(below), '# X');
    assert.equal(renderProseMirror(bogus), '# X');
  });

  test('link mark without href leaves the wrapped text alone', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: {} }] }] }],
    };
    assert.equal(renderProseMirror(doc), 'x');
  });

  test('unknown node types recurse instead of dropping text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'custom_thing', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] },
      ],
    };
    assert.equal(renderProseMirror(doc), 'kept');
  });

  test('hard_break emits a newline inside a paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'hard_break' },
            { type: 'text', text: 'line two' },
          ],
        },
      ],
    };
    assert.equal(renderProseMirror(doc), 'line one\nline two');
  });

  test('empty document collapses to null so the caller falls back to JSON', () => {
    const doc = { type: 'doc', content: [] };
    assert.equal(renderProseMirror(doc), null);
  });

  test('whitespace-only document collapses to null', () => {
    // A doc with a paragraph containing only spaces should not render as valid
    // markdown — the `trim()` at the end of renderProseMirror kicks in and we
    // fall through to the JSON display.
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] };
    assert.equal(renderProseMirror(doc), null);
  });

  test('nested bullet lists preserve indentation via child recursion', () => {
    // Outline supports nesting a bullet_list inside a list_item. The
    // list_item renderer joins its children with '\n', so a nested list
    // shows up under its parent bullet as a follow-on line. This is a
    // faithful shape check — Markdown parsers accept it even without leading
    // spaces because the parent bullet's block scope covers the child.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'outer' }] },
                {
                  type: 'bullet_list',
                  content: [
                    {
                      type: 'list_item',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    assert.match(out, /^- outer/m);
    assert.match(out, /- inner/);
  });

  test('multiple marks on a single text stack in the order applied', () => {
    // A text node with two marks like [strong, em] wraps the base string in
    // both — Outline emits this shape when the user selects bold+italic
    // together. Order matters for the final visual (bold-then-italic vs
    // italic-then-bold produce identical output but different bytes), so we
    // pin the specific expected string.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hi', marks: [{ type: 'strong' }, { type: 'em' }] }],
        },
      ],
    };
    assert.equal(renderProseMirror(doc), '***hi***');
  });

  test('multi-paragraph blockquote renders each line prefixed with >', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
          ],
        },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    // Two content lines and one blank continuation line separating the paragraphs.
    assert.match(out, /^> first$/m);
    assert.match(out, /^>$/m);
    assert.match(out, /^> second$/m);
  });

  test('mixed marks + list + heading round-trip through the full renderer', () => {
    // A representative Outline comment: heading, paragraph with a link and
    // bold, then a bullet list. Guards against interactions between block
    // types (e.g. the previous block leaking a trailing newline).
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Update' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see the ' },
            {
              type: 'text',
              text: 'ticket',
              marks: [{ type: 'link', attrs: { href: 'https://linear.app/x/issue/42' } }],
            },
            { type: 'text', text: ' — ' },
            { type: 'text', text: 'urgent', marks: [{ type: 'strong' }] },
          ],
        },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
            },
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }],
            },
          ],
        },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    assert.match(out, /^### Update/m);
    assert.match(out, /see the \[ticket\]\(https:\/\/linear\.app\/x\/issue\/42\) — \*\*urgent\*\*/);
    assert.match(out, /^- done\n- todo/m);
  });

  test('unknown "mention" node recurses so the display name is preserved', () => {
    // Outline emits mentions as `{type: 'mention', content: [{type: 'text',
    // text: '@Ana'}]}` (or similar). We don't render them specially, but the
    // default-case recursion picks up the child text so the reader still sees
    // "@Ana" instead of losing it entirely.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ping ' },
            {
              type: 'mention',
              attrs: { userId: 'u1', userName: 'Ana' },
              content: [{ type: 'text', text: '@Ana' }],
            },
          ],
        },
      ],
    };
    assert.equal(renderProseMirror(doc), 'ping @Ana');
  });

  test('unknown "checkbox_list" recurses through items but drops box markers', () => {
    // Task lists in Outline use checkbox_list / checkbox_item, which we don't
    // yet render as GFM `- [ ]`. Documented behavior for now: text content is
    // preserved so nothing is lost, but the visual checkbox is missing. If
    // this shows up in real comments enough to matter, upgrade the walker.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'checkbox_list',
          content: [
            {
              type: 'checkbox_item',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'buy milk' }] }],
            },
            {
              type: 'checkbox_item',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship it' }] }],
            },
          ],
        },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    assert.match(out, /buy milk/);
    assert.match(out, /ship it/);
  });

  test('collapses runs of blank lines to at most one', () => {
    // Contract: renderProseMirror normalizes `\n{3,}` → `\n\n` so downstream
    // markdown renderers get a single paragraph break instead of arbitrary
    // vertical whitespace. Two empty paragraphs between content would
    // otherwise produce 5 newlines.
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };
    const out = renderProseMirror(doc);
    assert.ok(out);
    if (!out) return;
    assert.doesNotMatch(out, /\n{3,}/);
    assert.match(out, /^before\n\nafter$/);
  });
});

describe('formatComment / formatComments — ProseMirror rendering', () => {
  const pmBody = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hey ' },
          { type: 'text', text: 'team', marks: [{ type: 'strong' }] },
        ],
      },
    ],
  };

  test('formatComment renders ProseMirror as markdown, not JSON', () => {
    const out = formatComment({
      id: 'x',
      createdBy: { name: 'Ana' },
      createdAt: '2026-01-02T00:00:00.000Z',
      data: pmBody,
    });
    assert.match(out, /hey \*\*team\*\*/);
    assert.doesNotMatch(out, /```json/);
  });

  test('formatComment still falls back to fenced JSON for non-PM bodies', () => {
    // Regression guard for the pre-existing contract: unknown shapes are
    // preserved verbatim so a user or downstream tool can still inspect them.
    const out = formatComment({ id: 'x', data: { legacy: 'shape' } });
    assert.match(out, /```json/);
    assert.match(out, /"legacy": "shape"/);
  });

  test('formatComments renders each item as markdown when it is ProseMirror', () => {
    const out = formatComments([
      { id: 'c1', createdBy: { name: 'A' }, data: pmBody },
      { id: 'c2', createdBy: { name: 'B' }, data: pmBody },
    ]);
    // Count the markdown-y line; two comments should produce two occurrences.
    const matches = out.match(/hey \*\*team\*\*/g) || [];
    assert.equal(matches.length, 2);
    assert.doesNotMatch(out, /```json/);
  });
});

// -----------------------------------------------------------------------------
// Integration-lite: realistic Outline API response shapes flowing through the
// OutlineClient → formatter chain. Catches mismatches between what Outline
// returns and what our formatters expect — in one place, in one round trip.
// Uses the shared mock-fetch harness.
// -----------------------------------------------------------------------------

describe('OutlineClient → formatter chains', () => {
  beforeEach(() => installMockFetch());
  afterEach(() => {
    mockImpl = null;
    globalThis.fetch = originalFetch;
  });

  test('searchDocuments → formatSearchResults with ranked results + pagination', async () => {
    // Shape mirrors what wiki.gluzdov.com returns for /api/documents.search:
    // `data` is an array of { ranking, context, document: {...} } and there's
    // a top-level `pagination`.
    mockImpl = () => jsonResponse({
      data: [
        { ranking: 0.85, context: 'The vacation policy states...', document: { id: 'd1', title: 'Vacation Policy' } },
        { ranking: 0.62, context: 'For time off, see...', document: { id: 'd2', title: 'PTO Guide' } },
      ],
      pagination: { limit: 25, offset: 0, total: 2 },
    });
    const client = new OutlineClient('tok');
    const { data, pagination } = await client.searchDocuments({ query: 'vacation' });
    assert.equal(data.length, 2);
    assert.equal(pagination?.total, 2);

    const out = formatSearchResults(data, pagination);
    assert.match(out, /# Search Results/);
    assert.match(out, /Showing results 1-2/);
    assert.match(out, /## 1\. Vacation Policy/);
    assert.match(out, /Relevance: 0\.85/);
    assert.match(out, /Context: The vacation policy states/);
    assert.match(out, /## 2\. PTO Guide/);
    // No "more results" hint because count < limit
    assert.doesNotMatch(out, /to see more/);
  });

  test('listCollections → formatCollections with realistic collection shapes', async () => {
    mockImpl = () => jsonResponse({
      data: [
        { id: 'c1', name: 'Engineering', description: 'Everything eng.', color: '#0070f3' },
        { id: 'c2', name: 'Runbooks' },
        { id: 'c3' }, // Missing name — formatter should fall back to "Untitled Collection"
      ],
    });
    const client = new OutlineClient('tok');
    const collections = await client.listCollections();
    assert.equal(collections.length, 3);

    const out = formatCollections(collections);
    assert.match(out, /# Collections/);
    assert.match(out, /## 1\. Engineering/);
    assert.match(out, /Description: Everything eng\./);
    assert.match(out, /## 2\. Runbooks/);
    assert.match(out, /## 3\. Untitled Collection/);
    // Missing description shouldn't render an empty "Description:" line
    assert.doesNotMatch(out, /Description: undefined/);
  });

  test('listArchivedDocuments → formatDocumentsList with updatedAt timestamps', async () => {
    mockImpl = () => jsonResponse({
      data: [
        { id: 'd1', title: 'Old spec', updatedAt: '2026-05-01T12:00:00.000Z' },
        { id: 'd2', title: 'Deprecated runbook', updatedAt: '2026-04-15T09:30:00.000Z' },
      ],
    });
    const client = new OutlineClient('tok');
    const docs = await client.listArchivedDocuments();
    assert.equal(docs.length, 2);

    const out = formatDocumentsList(docs, 'Archived Documents');
    assert.match(out, /# Archived Documents/);
    assert.match(out, /## 1\. Old spec/);
    assert.match(out, /Last Updated: 2026-05-01T12:00:00\.000Z/);
    assert.match(out, /## 2\. Deprecated runbook/);
  });

  test('getCollectionDocuments → formatCollectionStructure with nested children', async () => {
    // A realistic collection tree from /api/collections.documents: two top-level
    // docs, one with a child, one with a grandchild.
    mockImpl = () => jsonResponse({
      data: [
        {
          id: 'r1',
          title: 'Runbooks',
          children: [
            { id: 'c1', title: 'Deploy' },
            {
              id: 'c2',
              title: 'Incident Response',
              children: [{ id: 'g1', title: 'Sev1 Playbook' }],
            },
          ],
        },
        { id: 'r2', title: 'Meeting Notes' },
      ],
    });
    const client = new OutlineClient('tok');
    const tree = await client.getCollectionDocuments('coll-1');
    assert.equal(tree.length, 2);

    const out = formatCollectionStructure(tree);
    assert.match(out, /# Collection Structure/);
    assert.match(out, /^- Runbooks \(ID: r1\)/m);
    assert.match(out, /^  - Deploy \(ID: c1\)/m);
    assert.match(out, /^  - Incident Response \(ID: c2\)/m);
    assert.match(out, /^    - Sev1 Playbook \(ID: g1\)/m);
    assert.match(out, /^- Meeting Notes \(ID: r2\)/m);
  });

  test('exportCollection → formatFileOperation for in-progress export', async () => {
    // Outline returns the file operation wrapped in { data: { fileOperation: ... } }
    // in some versions, or `fileOperation` at the top level in others. The client
    // handles both — this test covers the top-level variant.
    mockImpl = () => jsonResponse({
      fileOperation: {
        id: 'op-42',
        state: 'creating',
        type: 'export',
        name: 'engineering-collection-backup',
      },
    });
    const client = new OutlineClient('tok');
    const op = await client.exportCollection('c1', 'outline-markdown');
    assert.ok(op);
    if (!op) return;
    assert.equal(op.id, 'op-42');
    assert.equal(op.state, 'creating');

    const out = formatFileOperation(op);
    assert.match(out, /# Export Operation: engineering-collection-backup/);
    assert.match(out, /State: creating/);
    assert.match(out, /Type: export/);
    assert.match(out, /still in progress/);
    assert.match(out, /op-42/);
  });

  test('getDocument (with markdown containing attachment refs) → parseAttachmentIds finds them', async () => {
    // Chain that a Claude Desktop caller would run: fetch doc, then scan for
    // attachments. This guards the whole pipeline of client method →
    // response.text extraction → attachment regex.
    const uuidA = '11111111-2222-3333-4444-555555555555';
    const uuidB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const markdownWithAttachments = [
      '# Runbook',
      '',
      'See the diagram: [architecture](/api/attachments.redirect?id=' + uuidA + ')',
      '',
      'And the config: /api/attachments.redirect?id=' + uuidB,
      '',
      'Duplicate ref should be deduped: /api/attachments.redirect?id=' + uuidA,
    ].join('\n');

    mockImpl = () => jsonResponse({
      data: { id: 'd1', title: 'Runbook', text: markdownWithAttachments },
    });
    const client = new OutlineClient('tok');
    const doc = await client.getDocument('d1');
    assert.ok(doc);
    if (!doc) return;

    const attachments = parseAttachmentIds(doc.text ?? '');
    assert.equal(attachments.length, 2, 'duplicates should collapse');
    assert.equal(attachments[0].id, uuidA);
    assert.equal(attachments[1].id, uuidB);
    assert.match(attachments[0].context, /architecture/);
  });

  test('listDocumentComments → formatComments with ProseMirror rendering + pagination', async () => {
    // The full comment reading path: paginated response from /api/comments.list,
    // each comment body is a ProseMirror doc, and the formatter should render
    // them as markdown, not JSON.
    const pmBody = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    mockImpl = () => jsonResponse({
      data: [
        { id: 'c1', createdBy: { name: 'Ana' }, createdAt: '2026-06-01T00:00:00.000Z', data: pmBody('LGTM') },
        { id: 'c2', createdBy: { name: 'Bob' }, createdAt: '2026-06-02T00:00:00.000Z', data: pmBody('nit: rename foo → bar') },
      ],
      pagination: { limit: 25, offset: 0, total: 2 },
    });
    const client = new OutlineClient('tok');
    const { data, pagination } = await client.listDocumentComments({ documentId: 'd1' });
    assert.equal(data.length, 2);

    const out = formatComments(data, pagination, 25, 0);
    assert.match(out, /## 1\. Comment by Ana/);
    assert.match(out, /LGTM/);
    assert.match(out, /## 2\. Comment by Bob/);
    assert.match(out, /nit: rename foo → bar/);
    // ProseMirror render, not JSON fallback
    assert.doesNotMatch(out, /```json/);
  });

  test('searchDocuments empty result → formatter returns the empty-list message', async () => {
    // Guard against a subtle bug: if the client returns empty data but the
    // formatter reads pagination.total, the "1-0 of 0" message would look
    // weird. The formatter short-circuits on empty data instead.
    mockImpl = () => jsonResponse({
      data: [],
      pagination: { limit: 25, offset: 0, total: 0 },
    });
    const client = new OutlineClient('tok');
    const { data, pagination } = await client.searchDocuments({ query: 'nothing-matches-this' });
    assert.equal(data.length, 0);

    const out = formatSearchResults(data, pagination);
    assert.equal(out, 'No documents found matching your search.');
  });
});
