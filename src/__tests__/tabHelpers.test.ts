import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getTabTextLength, findTabById, getAllTabs } from '../google-docs/apiHelpers.js';

describe('getTabTextLength', () => {

  it('returns 0 for undefined documentTab', () => {
    assert.equal(getTabTextLength(undefined), 0);
  });

  it('returns 0 for documentTab with no body', () => {
    assert.equal(getTabTextLength({} as any), 0);
  });

  it('returns 0 for documentTab with empty content', () => {
    assert.equal(getTabTextLength({ body: { content: [] } }), 0);
  });

  it('counts paragraph text length', () => {
    const tab = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Hello' } },
                { textRun: { content: ' World' } },
              ],
            },
          },
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Line 2\n' } },
              ],
            },
          },
        ],
      },
    };
    assert.equal(getTabTextLength(tab), 18); // 'Hello' + ' World' + 'Line 2\n'
  });

  it('counts text inside table cells', () => {
    const tab = {
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: 'Cell A' } }] } },
                      ],
                    },
                    {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: 'Cell B' } }] } },
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
    assert.equal(getTabTextLength(tab), 12); // 'Cell A' + 'Cell B'
  });

  it('handles mixed paragraphs and tables', () => {
    const tab = {
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Intro\n' } }],
            },
          },
          {
            table: {
              tableRows: [{
                tableCells: [{
                  content: [{
                    paragraph: { elements: [{ textRun: { content: 'Cell' } }] },
                  }],
                }],
              }],
            },
          },
        ],
      },
    };
    assert.equal(getTabTextLength(tab), 10); // 'Intro\n' + 'Cell'
  });

  it('skips elements without textRun content', () => {
    const tab = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { inlineObjectElement: {} },
                { textRun: { content: 'Text' } },
              ],
            },
          },
        ],
      },
    };
    assert.equal(getTabTextLength(tab), 4);
  });
});

describe('findTabById', () => {

  it('returns null for doc with no tabs', () => {
    assert.equal(findTabById({ tabs: [] }, 'any'), null);
  });

  it('returns null for doc with undefined tabs', () => {
    assert.equal(findTabById({}, 'any'), null);
  });

  it('finds a top-level tab', () => {
    const doc = {
      tabs: [
        { tabProperties: { tabId: 'tab1', title: 'First' }, childTabs: [] },
        { tabProperties: { tabId: 'tab2', title: 'Second' }, childTabs: [] },
      ],
    };
    const tab = findTabById(doc, 'tab2');
    assert.ok(tab);
    assert.equal(tab!.tabProperties!.title, 'Second');
  });

  it('finds a nested child tab', () => {
    const doc = {
      tabs: [
        {
          tabProperties: { tabId: 'parent', title: 'Parent' },
          childTabs: [
            { tabProperties: { tabId: 'child', title: 'Child' }, childTabs: [] },
          ],
        },
      ],
    };
    const tab = findTabById(doc, 'child');
    assert.ok(tab);
    assert.equal(tab!.tabProperties!.title, 'Child');
  });

  it('finds a deeply nested child tab', () => {
    const doc = {
      tabs: [
        {
          tabProperties: { tabId: 'l0', title: 'Level 0' },
          childTabs: [
            {
              tabProperties: { tabId: 'l1', title: 'Level 1' },
              childTabs: [
                { tabProperties: { tabId: 'l2', title: 'Level 2' }, childTabs: [] },
              ],
            },
          ],
        },
      ],
    };
    const tab = findTabById(doc, 'l2');
    assert.ok(tab);
    assert.equal(tab!.tabProperties!.title, 'Level 2');
  });

  it('returns null when tab ID does not exist', () => {
    const doc = {
      tabs: [
        { tabProperties: { tabId: 'tab1', title: 'Only Tab' }, childTabs: [] },
      ],
    };
    assert.equal(findTabById(doc, 'nonexistent'), null);
  });
});

describe('getAllTabs', () => {

  it('returns empty array for doc with no tabs', () => {
    assert.deepEqual(getAllTabs({}), []);
  });

  it('returns flat list with level info for nested tabs', () => {
    const doc = {
      tabs: [
        {
          tabProperties: { tabId: 't1', title: 'Tab 1' },
          childTabs: [
            { tabProperties: { tabId: 't1a', title: 'Sub' }, childTabs: [] },
          ],
        },
        { tabProperties: { tabId: 't2', title: 'Tab 2' }, childTabs: [] },
      ],
    };
    const tabs = getAllTabs(doc);
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0].level, 0);
    assert.equal(tabs[1].level, 1);
    assert.equal(tabs[2].level, 0);
  });
});
