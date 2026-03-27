import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docs_v1 } from 'googleapis';
import { parseDocStructure } from '../google-docs/apiHelpers.js';

// Helper to build a minimal mock document
function makeDoc(overrides: Partial<docs_v1.Schema$Document> = {}): docs_v1.Schema$Document {
  return {
    title: 'Test Document',
    tabs: [{
      tabProperties: { tabId: 'tab1', title: 'Tab 1' },
      documentTab: {
        body: { content: [] },
      },
      childTabs: [],
    }],
    ...overrides,
  };
}

function makeParagraph(startIndex: number, endIndex: number, text: string, namedStyleType?: string): docs_v1.Schema$StructuralElement {
  return {
    startIndex,
    endIndex,
    paragraph: {
      elements: [{
        startIndex,
        endIndex,
        textRun: { content: text },
      }],
      paragraphStyle: namedStyleType ? { namedStyleType } : undefined,
    },
  };
}

function makeTable(startIndex: number, endIndex: number, rows: number, cols: number): docs_v1.Schema$StructuralElement {
  const tableRows: docs_v1.Schema$TableRow[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: docs_v1.Schema$TableCell[] = [];
    for (let c = 0; c < cols; c++) {
      cells.push({ content: [] });
    }
    tableRows.push({ tableCells: cells });
  }
  return {
    startIndex,
    endIndex,
    table: { tableRows, rows, columns: cols },
  };
}

// --- Summary mode tests ---

describe('parseDocStructure - summary mode', () => {

  it('returns zero counts for empty document', () => {
    const doc = makeDoc();
    const result = parseDocStructure(doc, false);
    assert.equal(result.paragraphCount, 0);
    assert.equal(result.tableCount, 0);
    assert.equal(result.sectionBreakCount, 0);
    assert.equal(result.documentLength, 0);
    assert.equal(result.title, 'Test Document');
  });

  it('counts paragraphs correctly', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 10, 'Hello'),
              makeParagraph(10, 25, 'World'),
              makeParagraph(25, 40, 'Third'),
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, false);
    assert.equal(result.paragraphCount, 3);
    assert.equal(result.documentLength, 40);
  });

  it('counts tables correctly', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 5, 'Intro'),
              makeTable(5, 50, 3, 4),
              makeTable(50, 100, 2, 2),
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, false);
    assert.equal(result.tableCount, 2);
    assert.equal(result.paragraphCount, 1);
  });

  it('counts paragraphs nested inside table cells', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 5, 'Before'),
              {
                startIndex: 5,
                endIndex: 50,
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        { content: [makeParagraph(6, 15, 'Cell A1'), makeParagraph(15, 25, 'Cell A1 p2')] },
                        { content: [makeParagraph(25, 35, 'Cell B1')] },
                      ],
                    },
                    {
                      tableCells: [
                        { content: [makeParagraph(35, 45, 'Cell A2')] },
                        { content: [makeParagraph(45, 50, 'Cell B2')] },
                      ],
                    },
                  ],
                  rows: 2,
                  columns: 2,
                },
              },
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, false);
    // 1 top-level paragraph + 5 paragraphs inside table cells
    assert.equal(result.paragraphCount, 6);
    assert.equal(result.tableCount, 1);
  });

  it('includes nested table cell paragraphs in detailed elements', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              {
                startIndex: 0,
                endIndex: 30,
                table: {
                  tableRows: [{
                    tableCells: [
                      { content: [makeParagraph(1, 10, 'In cell')] },
                    ],
                  }],
                  rows: 1,
                  columns: 1,
                },
              },
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, true);
    assert.ok(result.elements);
    // table element + nested paragraph
    const tableEl = result.elements!.find(e => e.type === 'table');
    const paraEl = result.elements!.find(e => e.type === 'paragraph');
    assert.ok(tableEl);
    assert.ok(paraEl);
    assert.equal(paraEl!.textPreview, 'In cell');
  });

  it('falls back to legacy doc.body when no tabs exist', () => {
    const doc: any = {
      title: 'Legacy Doc',
      tabs: [],
      body: {
        content: [
          makeParagraph(0, 10, 'Legacy content'),
        ],
      },
      headers: {},
      footers: {},
    };
    const result = parseDocStructure(doc, false);
    assert.equal(result.paragraphCount, 1);
    assert.equal(result.title, 'Legacy Doc');
  });

  it('detects headers and footers presence', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: { content: [] },
          headers: { 'h1': { headerId: 'h1' } } as any,
          footers: { 'f1': { footerId: 'f1' } } as any,
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, false);
    assert.equal(result.hasHeaders, true);
    assert.equal(result.hasFooters, true);
  });

  it('extracts tab hierarchy', () => {
    const doc = makeDoc({
      tabs: [
        {
          tabProperties: { tabId: 'tab1', title: 'Main' },
          documentTab: { body: { content: [] } },
          childTabs: [
            {
              tabProperties: { tabId: 'tab1a', title: 'Sub Tab' },
              documentTab: { body: { content: [] } },
              childTabs: [],
            },
          ],
        },
        {
          tabProperties: { tabId: 'tab2', title: 'Second' },
          documentTab: { body: { content: [] } },
          childTabs: [],
        },
      ],
    });
    const result = parseDocStructure(doc, false);
    assert.equal(result.tabs.length, 3);
    assert.equal(result.tabs[0].title, 'Main');
    assert.equal(result.tabs[0].level, 0);
    assert.equal(result.tabs[1].title, 'Sub Tab');
    assert.equal(result.tabs[1].level, 1);
    assert.equal(result.tabs[2].title, 'Second');
    assert.equal(result.tabs[2].level, 0);
  });
});

// --- Detailed mode tests ---

describe('parseDocStructure - detailed mode', () => {

  it('returns element-by-element listing with type and position', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 10, 'Hello'),
              makeTable(10, 50, 2, 3),
              { startIndex: 50, endIndex: 51, sectionBreak: {} },
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, true);
    assert.ok(result.elements);
    assert.equal(result.elements!.length, 3);
    assert.equal(result.elements![0].type, 'paragraph');
    assert.equal(result.elements![0].startIndex, 0);
    assert.equal(result.elements![1].type, 'table');
    assert.equal(result.elements![1].tableRows, 2);
    assert.equal(result.elements![1].tableColumns, 3);
    assert.equal(result.elements![2].type, 'sectionBreak');
  });

  it('includes text previews for paragraphs', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 20, 'Short text', 'HEADING_1'),
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, true);
    assert.ok(result.elements);
    assert.equal(result.elements![0].textPreview, 'Short text');
    assert.equal(result.elements![0].namedStyleType, 'HEADING_1');
  });

  it('truncates text previews at 100 chars', () => {
    const longText = 'A'.repeat(150);
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 160, longText),
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, true);
    assert.ok(result.elements);
    assert.equal(result.elements![0].textPreview!.length, 103); // 100 + '...'
    assert.ok(result.elements![0].textPreview!.endsWith('...'));
  });

  it('includes tableOfContents elements in detailed mode', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: {
          body: {
            content: [
              makeParagraph(0, 10, 'Intro'),
              { startIndex: 10, endIndex: 30, tableOfContents: {} },
            ],
          },
        },
        childTabs: [],
      }],
    });
    const result = parseDocStructure(doc, true);
    assert.ok(result.elements);
    const tocEl = result.elements!.find(e => e.type === 'tableOfContents');
    assert.ok(tocEl);
    assert.equal(tocEl!.startIndex, 10);
    assert.equal(tocEl!.endIndex, 30);
  });

  it('finds tab by ID in nested child tabs', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'parent', title: 'Parent' },
        documentTab: { body: { content: [] } },
        childTabs: [{
          tabProperties: { tabId: 'child', title: 'Child' },
          documentTab: {
            body: {
              content: [
                makeParagraph(0, 5, 'A'),
                makeParagraph(5, 10, 'B'),
              ],
            },
          },
          childTabs: [],
        }],
      }],
    });
    const result = parseDocStructure(doc, false, 'child');
    assert.equal(result.paragraphCount, 2);
  });

  it('respects tabId parameter', () => {
    const doc = makeDoc({
      tabs: [
        {
          tabProperties: { tabId: 'tab1', title: 'Tab 1' },
          documentTab: {
            body: {
              content: [
                makeParagraph(0, 10, 'Tab 1 content'),
              ],
            },
          },
          childTabs: [],
        },
        {
          tabProperties: { tabId: 'tab2', title: 'Tab 2' },
          documentTab: {
            body: {
              content: [
                makeParagraph(0, 5, 'A'),
                makeParagraph(5, 10, 'B'),
                makeParagraph(10, 15, 'C'),
              ],
            },
          },
          childTabs: [],
        },
      ],
    });
    const result = parseDocStructure(doc, false, 'tab2');
    assert.equal(result.paragraphCount, 3);
  });

  it('throws when tabId is provided but does not exist', () => {
    const doc = makeDoc({
      tabs: [{
        tabProperties: { tabId: 'tab1', title: 'Tab 1' },
        documentTab: { body: { content: [makeParagraph(0, 5, 'A')] } },
        childTabs: [],
      }],
    });
    assert.throws(
      () => parseDocStructure(doc, false, 'nonexistent'),
      (err: any) => {
        assert.match(err.message, /tabId "nonexistent" does not exist/);
        return true;
      }
    );
  });
});
