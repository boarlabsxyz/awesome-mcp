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
    assert.match(out, /  - Child 1 \(ID: c1\)/);
    assert.match(out, /    - Grand \(ID: g1\)/);
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
      '/api/documents.unarchive',
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
