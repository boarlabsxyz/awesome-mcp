import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  selectTabContent,
  extractDocBodyText,
  truncateJsonByLength,
  findTabByIdShallow,
} from '../website/docContent.js';

describe('docContent.findTabByIdShallow', () => {
  it('returns null for an empty/undefined tab tree', () => {
    assert.equal(findTabByIdShallow(undefined, 'x'), null);
    assert.equal(findTabByIdShallow([], 'x'), null);
  });

  it('finds a tab at the root level', () => {
    const tabs = [{ tabProperties: { tabId: 'a' } }, { tabProperties: { tabId: 'b' } }];
    assert.equal(findTabByIdShallow(tabs as any, 'b')?.tabProperties?.tabId, 'b');
  });

  it('finds a tab nested in childTabs', () => {
    const tabs = [{ tabProperties: { tabId: 'a' }, childTabs: [{ tabProperties: { tabId: 'a.1' } }] }];
    assert.equal(findTabByIdShallow(tabs as any, 'a.1')?.tabProperties?.tabId, 'a.1');
  });

  it('returns null when the id is absent', () => {
    const tabs = [{ tabProperties: { tabId: 'a' } }];
    assert.equal(findTabByIdShallow(tabs as any, 'missing'), null);
  });
});

describe('docContent.selectTabContent', () => {
  it('returns notFound when the tab id is unknown', () => {
    const out = selectTabContent({ tabs: [{ tabProperties: { tabId: 'a' } }] } as any, 'x');
    assert.equal(out.kind, 'notFound');
    if (out.kind === 'notFound') assert.match(out.message, /not found/i);
  });

  it('returns badRequest when the tab has no documentTab', () => {
    const out = selectTabContent({ tabs: [{ tabProperties: { tabId: 'a' } }] } as any, 'a');
    assert.equal(out.kind, 'badRequest');
    if (out.kind === 'badRequest') assert.match(out.message, /does not have content/i);
  });

  it('returns ok with the tab body when valid', () => {
    const body = { content: ['x'] };
    const out = selectTabContent(
      { tabs: [{ tabProperties: { tabId: 'a' }, documentTab: { body } }] } as any,
      'a',
    );
    assert.equal(out.kind, 'ok');
    if (out.kind === 'ok') assert.deepEqual((out.content as any).body, body);
  });
});

describe('docContent.extractDocBodyText', () => {
  it('returns empty string for empty/undefined input', () => {
    assert.equal(extractDocBodyText(undefined), '');
    assert.equal(extractDocBodyText({}), '');
    assert.equal(extractDocBodyText({ body: {} } as any), '');
  });

  it('concatenates paragraph text runs', () => {
    const source = {
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }],
            },
          },
        ],
      },
    };
    assert.equal(extractDocBodyText(source as any), 'Hello world\n');
  });

  it('walks table cells', () => {
    const source = {
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: 'cell-1' } }] } },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    assert.equal(extractDocBodyText(source as any), 'cell-1');
  });

  it('skips elements without textRun', () => {
    const source = {
      body: {
        content: [{ paragraph: { elements: [{ inlineObjectElement: {} }] } }],
      },
    };
    assert.equal(extractDocBodyText(source as any), '');
  });
});

describe('docContent.truncateJsonByLength', () => {
  it('returns unchanged when maxLength is 0', () => {
    const r = truncateJsonByLength({ a: 1 }, 0);
    assert.equal(r.truncated, false);
    if (!r.truncated) assert.deepEqual(r.payload, { a: 1 });
  });

  it('returns unchanged when serialised length fits', () => {
    const r = truncateJsonByLength({ a: 1 }, 1000);
    assert.equal(r.truncated, false);
  });

  it('truncates when serialised length exceeds maxLength', () => {
    const big = { s: 'x'.repeat(1000) };
    const r = truncateJsonByLength(big, 50);
    assert.equal(r.truncated, true);
    if (r.truncated) {
      assert.ok(r.originalLength > 50);
      assert.equal(r.truncatedJson.length, 50);
      assert.ok(r.truncatedJson.startsWith('{"s":"'));
    }
  });

  it('returns partial string even when the cut lands mid-quote (no JSON.parse)', () => {
    // Previously the helper tried to JSON.parse the truncated string, which
    // threw "Unterminated string" when the cut landed inside a quoted value.
    const r = truncateJsonByLength({ s: 'abcdefghij' }, 8);
    assert.equal(r.truncated, true);
    if (r.truncated) assert.equal(r.truncatedJson, '{"s":"ab');
  });
});
