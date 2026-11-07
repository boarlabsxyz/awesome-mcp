// src/__tests__/restRoutes.storage.test.ts
// Drives the Storage REST handlers with a real bearer and a fake Storage pool,
// which is the only way to show what the auth-gate test cannot: that a call
// reaches the CALLER's data (user id in every query), that the path overrides
// the body, that refusals map to 400 / 404 / 503 rather than a flat 500, and
// that a bulk insert past Express's 100 kb default is parsed, not 413'd.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import request from 'supertest';

import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';
import { createMcpCatalog } from '../mcpCatalogStore.js';
import { __setStoragePoolForTests } from '../storage/store.js';
import { storageErrorResponse } from '../storage/restRoutes.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createWebOnlyApp } from '../website/webServer.js';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

const collectionRow = {
  id: 9,
  name: 'people',
  description: 'People researched on LinkedIn',
  fields: {
    profileUrl: { type: 'url', required: true, description: 'LinkedIn URL' },
    name: { type: 'string', required: true, description: 'Full name' },
    followers: { type: 'integer', required: false, description: 'Followers' },
  },
  key_field: 'profileUrl',
  ttl_days: 30,
  version: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};
const ada = { profileUrl: 'https://l.in/ada', name: 'Ada' };
const adaRow = { id: 'r1', key: ada.profileUrl, data: ada, bytes: 50, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };

/** A fake pool answering each query with the rows of the first pattern it matches. */
function fakePool(responses: Array<[RegExp, any[]]>) {
  const calls: Array<{ text: string; params: any[] }> = [];
  __setStoragePoolForTests({
    query: async (text: string, params: any[] = []) => {
      calls.push({ text, params });
      const rows = responses.find(([re]) => re.test(text))?.[1] ?? [];
      return { rows, rowCount: rows.length };
    },
  });
  return calls;
}

const SELECT_COLLECTION = /SELECT \* FROM storage_collections WHERE user_id/;

describe('REST data plane: Storage handlers', () => {
  const app = createWebOnlyApp();
  let apiKey: string;
  let userId: number;
  let otherKey: string;
  let otherId: number;
  let outsiderKey: string;
  const savedAdmins = process.env.ADMIN_EMAILS;

  before(async () => {
    // Storage is admin-only: both test accounts are admins, the outsider is not.
    process.env.ADMIN_EMAILS = 'st-rest@example.com, st-other@example.com';
    await createMcpCatalog({
      slug: 'storage', name: 'Storage MCP', description: 'test',
      iconUrl: '', mcpUrl: '/storage', provider: 'storage', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });
    await createOrUpdateUser({ email: 'st-rest@example.com', googleId: 'google-st-rest', name: 'ST Rest' }, dummyTokens);
    const user = await getUserByGoogleId('google-st-rest');
    apiKey = (user as any).apiKey;
    userId = (user as any).id;
    await createMcpInstance(userId, 'storage', 'Storage', emptyGoogleTokens, null, 'storage', {} as any, null);

    // No Storage connector at all: Storage data is per user, so this account
    // is still served (its own, empty data) — never sent down the Google path.
    await createOrUpdateUser({ email: 'st-other@example.com', googleId: 'google-st-other', name: 'ST Other' }, dummyTokens);
    const other = await getUserByGoogleId('google-st-other');
    otherKey = (other as any).apiKey;
    otherId = (other as any).id;

    await createOrUpdateUser({ email: 'st-outsider@example.com', googleId: 'google-st-outsider', name: 'ST Outsider' }, dummyTokens);
    outsiderKey = ((await getUserByGoogleId('google-st-outsider')) as any).apiKey;
  });

  afterEach(() => __setStoragePoolForTests(null));
  after(() => {
    __setStoragePoolForTests(null);
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdmins;
  });

  it('refuses a caller who is not an admin with 403, before touching the database', async () => {
    const calls = fakePool([]);
    const res = await get('/api/v1/storage/collections', outsiderKey);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /administrators only/);
    assert.equal((await post('/api/v1/storage/collections/people/records', { records: [ada] }, outsiderKey)).status, 403);
    assert.equal(calls.length, 0);
  });

  const get = (path: string, key = apiKey) => request(app).get(path).set('Authorization', `Bearer ${key}`);
  const post = (path: string, body: unknown = {}, key = apiKey) =>
    request(app).post(path).set('Authorization', `Bearer ${key}`).send(body as any);

  it('lists the CALLER’s collections, also for an account with no Storage connector', async () => {
    const calls = fakePool([[/FROM storage_collections c/, [{ ...collectionRow, records: 2, total_bytes: 100, last_write: null }]]]);
    const res = await get('/api/v1/storage/collections');
    assert.equal(res.status, 200);
    assert.equal(res.body.collections[0].name, 'people');
    assert.equal(calls[0].params[0], userId);

    const otherCalls = fakePool([]);
    const empty = await get('/api/v1/storage/collections', otherKey);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.count, 0);
    assert.equal(otherCalls[0].params[0], otherId);
  });

  it('answers 404 for a missing collection or record, naming it', async () => {
    fakePool([]);
    const noCollection = await get('/api/v1/storage/collections/nope');
    assert.equal(noCollection.status, 404);
    assert.match(noCollection.body.error, /no collection "nope"/);

    fakePool([[SELECT_COLLECTION, [collectionRow]]]);
    const noRecord = await get('/api/v1/storage/collections/people/records/gone');
    assert.equal(noRecord.status, 404);
    assert.match(noRecord.body.error, /No record with id "gone"/);
  });

  it('gets a record by id, or by keyField value with ?by=key', async () => {
    const calls = fakePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [adaRow]]]);
    const byKey = await get(`/api/v1/storage/collections/people/records/${encodeURIComponent(ada.profileUrl)}?by=key`);
    assert.equal(byKey.status, 200);
    assert.equal(byKey.body._id, 'r1');
    const lookup = calls.find((c) => /FROM storage_records/.test(c.text))!;
    assert.match(lookup.text, /AND key = \$2/);
    assert.equal(lookup.params[1], ada.profileUrl);
  });

  it('finds with the body as arguments, the path naming the collection', async () => {
    const calls = fakePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, [{ ...adaRow, total: 1, sort_key: 'k' }]]]);
    const res = await post('/api/v1/storage/collections/people/find', { collection: 'ignored', where: [{ field: 'followers', op: 'gte', value: 10 }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(calls[0].params[1], 'people', 'path overrides the body');
  });

  it('refuses a malformed body with the schema issues, before touching the database', async () => {
    const calls = fakePool([]);
    const res = await post('/api/v1/storage/collections/people/records', { records: 'not an array' });
    assert.equal(res.status, 400);
    assert.ok(res.body.issues.fieldErrors.records);
    assert.equal(calls.length, 0);
  });

  it('refuses an array body and an unknown ?by instead of dropping them', async () => {
    const calls = fakePool([]);
    const arr = await post('/api/v1/storage/collections/people/find', [{ field: 'followers', op: 'gte', value: 10 }]);
    assert.equal(arr.status, 400, 'an unfiltered page would answer 200');
    assert.match(arr.body.error, /JSON object, not an array/);
    const by = await get('/api/v1/storage/collections/people/records/abc?by=keey');
    assert.equal(by.status, 400, 'not a 404 for an id lookup');
    assert.match(by.body.error, /by must be "id" or "key"/);
    assert.equal(calls.length, 0);
  });

  it('answers a schema mismatch as 400 with the per-record problem', async () => {
    fakePool([[SELECT_COLLECTION, [collectionRow]]]);
    const res = await post('/api/v1/storage/collections/people/records', { records: [{ ...ada, title: 'CTO' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /records\[0\]: unknown field\(s\) "title"/);
  });

  it('inserts: 201 when something was created, 200 for an upsert that only replaced', async () => {
    const base: Array<[RegExp, any[]]> = [
      [SELECT_COLLECTION, [collectionRow]],
      [/AS collections/, [{ collections: 1, bytes: 0 }]],
      [/count\(\*\) AS records/, [{ records: 0, bytes: 0 }]],
    ];
    fakePool([...base, [/INSERT INTO storage_records/, [{ id: 'n1', key: ada.profileUrl, inserted: true }]]]);
    const created = await post('/api/v1/storage/collections/people/records', { records: [ada] });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, 1);

    fakePool([...base, [/key = ANY/, [{ id: 'r1', key: ada.profileUrl, bytes: 40 }]], [/INSERT INTO storage_records/, [{ id: 'r1', key: ada.profileUrl, inserted: false }]]]);
    const replaced = await post('/api/v1/storage/collections/people/records', { records: [ada], onConflict: 'update' });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.updated, 1);
  });

  it('parses a bulk insert past 100 kb instead of answering 413', async () => {
    fakePool([]);
    const big = Array.from({ length: 400 }, (_, i) => ({ profileUrl: `https://l.in/${i}`, name: 'x'.repeat(400) }));
    const res = await post('/api/v1/storage/collections/nope/records', { records: big });
    assert.equal(res.status, 404, `expected the body to reach the op, got ${res.status}`);
  });

  it('updates the record the PATH names; an id or key in the body cannot redirect it', async () => {
    const calls = fakePool([
      [SELECT_COLLECTION, [collectionRow]],
      [/SELECT \* FROM storage_records/, [adaRow]],
      [/UPDATE storage_records SET data/, [{ ...adaRow, data: { ...ada, followers: 3 } }]],
    ]);
    const res = await post(`/api/v1/storage/collections/people/records/${encodeURIComponent(ada.profileUrl)}/update?by=key`, { key: 'https://l.in/other', id: 'x', set: { followers: 3 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.followers, 3);
    const lookup = calls.find((c) => /SELECT \* FROM storage_records/.test(c.text))!;
    assert.equal(lookup.params[1], ada.profileUrl);
  });

  it('answers 503 without a database, not an empty list', async () => {
    __setStoragePoolForTests(null);
    const res = await get('/api/v1/storage/collections');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /no database connection/);
  });
});

describe('storageErrorResponse', () => {
  it('maps tagged statuses, other UserErrors to 400, and anything else to a 500 that hides the message', () => {
    const userError = (message: string, code?: number) => Object.assign(new Error(message), { name: 'UserError', code });
    assert.deepEqual(storageErrorResponse(userError('gone', 404), 'f'), { status: 404, body: { error: 'gone' } });
    assert.deepEqual(storageErrorResponse(userError('no db', 503), 'f'), { status: 503, body: { error: 'no db' } });
    assert.deepEqual(storageErrorResponse(userError('bad'), 'f'), { status: 400, body: { error: 'bad' } });
    assert.deepEqual(storageErrorResponse(new Error('pg: connection reset'), 'Failed'), { status: 500, body: { error: 'Failed' } });
  });
});
