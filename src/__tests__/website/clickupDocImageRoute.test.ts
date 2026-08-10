import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { registerClickUpDocImageRoutes } from '../../website/webServer.js';
import { __setDocImagePoolForTests } from '../../clickup/docImageStore.js';

// Capture the GET /images/clickup-doc/:id handler by passing a fake Express app.
function captureHandler(): (req: any, res: any) => any {
  let handler: any;
  const fakeApp: any = { get: (_path: string, h: any) => { handler = h; } };
  registerClickUpDocImageRoutes(fakeApp);
  return handler;
}

function makeRes() {
  const r: any = { statusCode: 200, headers: {}, body: undefined, typeVal: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.type = (t: string) => { r.typeVal = t; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}

describe('registerClickUpDocImageRoutes', () => {
  afterEach(() => __setDocImagePoolForTests(null));

  it('serves stored image bytes with mime + nosniff + cache headers', async () => {
    __setDocImagePoolForTests({
      query: async () => ({ rows: [{ bytes: Buffer.from('IMG'), mime: 'image/png' }] }),
    });
    const handler = captureHandler();
    const res = makeRes();
    await handler({ params: { id: 'abc' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.typeVal, 'image/png');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(res.headers['Cache-Control'], /immutable/);
    assert.equal(res.body.toString(), 'IMG');
  });

  it('returns 404 when the id is unknown', async () => {
    __setDocImagePoolForTests({ query: async () => ({ rows: [] }) });
    const handler = captureHandler();
    const res = makeRes();
    await handler({ params: { id: 'missing' } }, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body, 'Not found');
  });

  it('returns 500 when the store throws (e.g. no Postgres)', async () => {
    // No pool injected → getDocImage throws → caught → 500.
    const handler = captureHandler();
    const res = makeRes();
    await handler({ params: { id: 'x' } }, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body, 'Internal error');
  });
});
