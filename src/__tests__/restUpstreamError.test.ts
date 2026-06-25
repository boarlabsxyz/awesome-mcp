import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sendUpstreamError } from '../website/restUpstreamError.js';

function mockRes() {
  const calls: { status?: number; jsonPayload?: unknown } = {};
  const res = {
    status(s: number) { calls.status = s; return this; },
    json(p: unknown) { calls.jsonPayload = p; },
    _calls: calls,
  } as any;
  return res;
}

describe('sendUpstreamError', () => {
  it('googleapis-style err.code 404 → 404 with the supplied notFound message', () => {
    const res = mockRes();
    sendUpstreamError(res, { code: 404 }, { notFound: 'Document not found', fallback: 'fb' });
    assert.equal(res._calls.status, 404);
    assert.deepEqual(res._calls.jsonPayload, { error: 'Document not found' });
  });

  it('googleapis-style err.code 403 → 403 Permission denied', () => {
    const res = mockRes();
    sendUpstreamError(res, { code: 403 }, { fallback: 'fb' });
    assert.equal(res._calls.status, 403);
    assert.deepEqual(res._calls.jsonPayload, { error: 'Permission denied' });
  });

  it('clickup-style err.response.status 404 → 404', () => {
    const res = mockRes();
    sendUpstreamError(res, { response: { status: 404 } }, { notFound: 'Doc not found', fallback: 'fb' });
    assert.equal(res._calls.status, 404);
    assert.deepEqual(res._calls.jsonPayload, { error: 'Doc not found' });
  });

  it('plain err.status 403 → 403', () => {
    const res = mockRes();
    sendUpstreamError(res, { status: 403 }, { fallback: 'fb' });
    assert.equal(res._calls.status, 403);
  });

  it('404 with no notFound supplied → default "Resource not found"', () => {
    const res = mockRes();
    sendUpstreamError(res, { code: 404 }, { fallback: 'fb' });
    assert.equal(res._calls.status, 404);
    assert.deepEqual(res._calls.jsonPayload, { error: 'Resource not found' });
  });

  it('non-404/403 with err.message → 500 with that message', () => {
    const res = mockRes();
    sendUpstreamError(res, { message: 'upstream timeout' }, { fallback: 'fb' });
    assert.equal(res._calls.status, 500);
    assert.deepEqual(res._calls.jsonPayload, { error: 'upstream timeout' });
  });

  it('no recognized status and empty message → 500 with the fallback', () => {
    const res = mockRes();
    sendUpstreamError(res, {}, { fallback: 'Failed to do thing' });
    assert.equal(res._calls.status, 500);
    assert.deepEqual(res._calls.jsonPayload, { error: 'Failed to do thing' });
  });

  it('null/undefined err → 500 with the fallback', () => {
    const r1 = mockRes(); sendUpstreamError(r1, null, { fallback: 'fb' });
    assert.equal(r1._calls.status, 500);
    assert.deepEqual(r1._calls.jsonPayload, { error: 'fb' });
    const r2 = mockRes(); sendUpstreamError(r2, undefined, { fallback: 'fb' });
    assert.equal(r2._calls.status, 500);
  });

  it('non-numeric err.code (e.g. "ENOTFOUND" from net) → 500, not crash', () => {
    const res = mockRes();
    sendUpstreamError(res, { code: 'ENOTFOUND', message: 'dns lookup' }, { fallback: 'fb' });
    assert.equal(res._calls.status, 500);
    assert.deepEqual(res._calls.jsonPayload, { error: 'dns lookup' });
  });
});
