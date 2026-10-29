import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { registerAdminUsageRoutes } from '../../usage/adminUsageRoutes.js';
import { __setUsagePoolForTests } from '../../usage/usageStore.js';

const ENDPOINTS = [
  '/api/admin/usage/overview',
  '/api/admin/usage/tools',
  '/api/admin/usage/errors',
  '/api/admin/usage/loops',
  '/api/admin/usage/users/5/events',
];

function makeApp(isAdmin = true) {
  const app = express();
  registerAdminUsageRoutes(app, (_req, res, next) => {
    if (!isAdmin) return res.status(403).json({ error: 'Access denied' });
    next();
  });
  return app;
}

const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) };

afterEach(() => __setUsagePoolForTests(null));

describe('admin usage routes', () => {
  for (const path of ENDPOINTS) {
    it(`${path} is behind the admin gate`, async () => {
      __setUsagePoolForTests(emptyPool);
      const res = await request(makeApp(false)).get(path);
      assert.equal(res.status, 403);
    });

    it(`${path} answers 503 without a database, not empty data`, async () => {
      const res = await request(makeApp()).get(path);
      assert.equal(res.status, 503);
      assert.match(res.body.error, /DATABASE_URL/);
    });

    it(`${path} answers JSON with a database`, async () => {
      __setUsagePoolForTests(emptyPool);
      const res = await request(makeApp()).get(path);
      assert.equal(res.status, 200);
      assert.equal(typeof res.body, 'object');
    });
  }

  it('refuses invalid filters with 400 before touching the database', async () => {
    let queried = false;
    __setUsagePoolForTests({ query: async () => { queried = true; return { rows: [] }; } });
    const res = await request(makeApp()).get('/api/admin/usage/tools?days=365');
    assert.equal(res.status, 400);
    assert.ok(res.body.issues.days);
    assert.equal(queried, false);
  });

  it('refuses a non-numeric user id', async () => {
    __setUsagePoolForTests(emptyPool);
    const res = await request(makeApp()).get('/api/admin/usage/users/abc/events');
    assert.equal(res.status, 400);
  });

  it('refuses a user id beyond Postgres INT range with 400, not a database 500', async () => {
    let queries = 0;
    __setUsagePoolForTests({ query: async () => { queries++; return { rows: [] }; } });
    const ok = await request(makeApp()).get('/api/admin/usage/users/2147483647/events');
    assert.equal(ok.status, 200);
    const before = queries;
    const res = await request(makeApp()).get('/api/admin/usage/users/2147483648/events');
    assert.equal(res.status, 400);
    assert.equal(queries, before, 'the out-of-range id must not reach the database');
  });

  it('answers 500 without leaking the database error', async () => {
    __setUsagePoolForTests({ query: async () => { throw new Error('relation "secret_table" does not exist'); } });
    const res = await request(makeApp()).get('/api/admin/usage/errors');
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /secret_table/);
  });
});
