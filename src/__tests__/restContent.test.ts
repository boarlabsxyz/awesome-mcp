import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { negotiateFormat, respondNegotiated } from '../website/restContent.js';

function mockReq(overrides: { accept?: string; format?: string } = {}): any {
  return {
    headers: overrides.accept ? { accept: overrides.accept } : {},
    query: overrides.format ? { format: overrides.format } : {},
  };
}

function mockRes() {
  const calls: { type?: string; sentText?: string; jsonPayload?: unknown } = {};
  return {
    type(t: string) { calls.type = t; return this; },
    send(s: string) { calls.sentText = s; },
    json(p: unknown) { calls.jsonPayload = p; },
    _calls: calls,
  } as any;
}

describe('restContent.negotiateFormat', () => {
  it('defaults to json when no header or query is set', () => {
    assert.equal(negotiateFormat(mockReq()), 'json');
  });

  it('returns json for Accept: application/json', () => {
    assert.equal(negotiateFormat(mockReq({ accept: 'application/json' })), 'json');
  });

  it('returns text for Accept: text/plain', () => {
    assert.equal(negotiateFormat(mockReq({ accept: 'text/plain' })), 'text');
  });

  it('returns text for Accept: text/markdown', () => {
    assert.equal(negotiateFormat(mockReq({ accept: 'text/markdown' })), 'text');
  });

  it('returns text for ?format=text', () => {
    assert.equal(negotiateFormat(mockReq({ format: 'text' })), 'text');
  });

  it('returns text for ?format=markdown', () => {
    assert.equal(negotiateFormat(mockReq({ format: 'markdown' })), 'text');
  });

  it('returns text for ?format=plain', () => {
    assert.equal(negotiateFormat(mockReq({ format: 'plain' })), 'text');
  });

  it('returns json for ?format=json even if Accept says text/plain', () => {
    assert.equal(negotiateFormat(mockReq({ accept: 'text/plain', format: 'json' })), 'json');
  });

  it('handles case-insensitive ?format value', () => {
    assert.equal(negotiateFormat(mockReq({ format: 'TEXT' })), 'text');
  });
});

describe('restContent.respondNegotiated', () => {
  it('sends JSON by default', () => {
    const res = mockRes();
    respondNegotiated(mockReq(), res, { ok: 1 }, () => 'rendered');
    assert.deepEqual(res._calls.jsonPayload, { ok: 1 });
    assert.equal(res._calls.sentText, undefined);
  });

  it('sends rendered text when Accept: text/plain', () => {
    const res = mockRes();
    respondNegotiated(mockReq({ accept: 'text/plain' }), res, { ok: 1 }, () => 'rendered text');
    assert.equal(res._calls.sentText, 'rendered text');
    assert.equal(res._calls.type, 'text/plain; charset=utf-8');
    assert.equal(res._calls.jsonPayload, undefined);
  });

  it('does not invoke renderText when sending JSON', () => {
    const res = mockRes();
    let called = false;
    respondNegotiated(mockReq(), res, { ok: 1 }, () => { called = true; return 'r'; });
    assert.equal(called, false);
  });
});
