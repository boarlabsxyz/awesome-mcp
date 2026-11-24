// src/__tests__/slidesRestRoutes.test.ts
// Drives every descriptor in SLIDES_WRITE_ROUTES against a stubbed client, the
// way gmailRestRoutes.test.ts does: what reaches Slides, the status, the answer,
// and the route's own error mapping.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { SLIDES_WRITE_ROUTES, writeArgs } from '../google-slides/restRoutes.js';
import type { SlidesWriteRoute } from '../google-slides/restRoutes.js';
import { REST_CATALOG } from '../restCatalog.js';

function mockSlides(overrides: Record<string, any> = {}) {
  return {
    presentations: {
      create: mock.fn(async () => ({ data: { presentationId: 'p1', title: 'Deck', slides: [] } })),
      batchUpdate: mock.fn(async () => ({
        data: { replies: [{ createSlide: { objectId: 's1' } }], writeControl: { requiredRevisionId: 'rev-2' } },
      })),
      ...overrides,
    },
  } as any;
}

function routeFor(tool: string): SlidesWriteRoute {
  const route = SLIDES_WRITE_ROUTES.find((r) => r.tool === tool);
  assert.ok(route, `no route for ${tool}`);
  return route;
}

async function call(tool: string, params: Record<string, string>, body: unknown, slides = mockSlides()) {
  const route = routeFor(tool);
  const parsed = route.schema.parse(writeArgs(route, { params, body }));
  return { ...(await route.run(slides, parsed)), slides };
}

describe('SLIDES_WRITE_ROUTES', () => {
  it('has one catalog entry per descriptor and none without one', () => {
    const catalogued = REST_CATALOG.filter((e) => e.service === 'slides' && e.method === 'POST');
    assert.equal(catalogued.length, SLIDES_WRITE_ROUTES.length);
    for (const route of SLIDES_WRITE_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      assert.ok(catalogued.some((e) => e.path === path && e.mcpToolName === route.tool), route.path);
    }
  });

  it('takes the presentation from the URL, not a mismatched body key', () => {
    const route = routeFor('batchUpdatePresentation');
    assert.deepEqual(
      writeArgs(route, { params: { presentationId: 'path' }, body: { presentationId: 'body', requests: [] } }),
      { presentationId: 'path', requests: [] },
    );
  });
});

describe('createPresentation keeps the legacy answer', () => {
  it('answers 200 with presentationId and title only', async () => {
    const { status, body, slides } = await call('createPresentation', {}, { title: 'Deck' });
    assert.equal(status, 200);
    assert.deepEqual(body, { presentationId: 'p1', title: 'Deck' });
    assert.deepEqual(slides.presentations.create.mock.calls[0].arguments[0], { requestBody: { title: 'Deck' } });
  });

  it('defaults the title, as the tool does', async () => {
    const { slides } = await call('createPresentation', {}, {});
    assert.equal(slides.presentations.create.mock.calls[0].arguments[0].requestBody.title, 'Untitled Presentation');
  });
});

describe('batchUpdatePresentation', () => {
  it('answers 200 with the replies and the new revision', async () => {
    const { status, body, slides } = await call(
      'batchUpdatePresentation', { presentationId: 'p1' }, { requests: [{ createSlide: {} }], requiredRevisionId: 'rev-1' },
    );
    assert.equal(status, 200);
    assert.deepEqual(body, { replies: [{ createSlide: { objectId: 's1' } }], revisionId: 'rev-2' });
    const req = slides.presentations.batchUpdate.mock.calls[0].arguments[0];
    assert.equal(req.presentationId, 'p1');
    assert.deepEqual(req.requestBody.writeControl, { requiredRevisionId: 'rev-1' });
  });

  it('answers revisionId null when Google returns none', async () => {
    const batchUpdate = mock.fn(async () => ({ data: {} }));
    const { body } = await call('batchUpdatePresentation', { presentationId: 'p1' }, { requests: [{ a: 1 }] }, mockSlides({ batchUpdate }));
    assert.deepEqual(body, { replies: [], revisionId: null });
  });

  it('refuses an empty batch without calling Google', async () => {
    const { status, body, slides } = await call('batchUpdatePresentation', { presentationId: 'p1' }, { requests: [] });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'requests is empty.' });
    assert.equal(slides.presentations.batchUpdate.mock.callCount(), 0);
  });

  it('maps a stale revision to 409 and a refused request to 400', () => {
    const route = routeFor('batchUpdatePresentation');
    const stale = Object.assign(new Error('Revision rev-1 is no longer current'), { code: 400 });
    assert.equal(route.errorResponse?.(stale, { requiredRevisionId: 'rev-1' })?.status, 409);
    assert.equal(route.errorResponse?.(stale, {})?.status, 400);
    assert.equal(route.errorResponse?.(Object.assign(new Error('gone'), { code: 404 }), {}), null);
  });
});
