import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  getSlidesClient,
  getDriveClient,
  extractTextRuns,
  extractElementTexts,
  handleCreatePresentation,
  handleGetPresentation,
  handleGetPage,
  handleGetPageThumbnail,
  handleBatchUpdatePresentation,
  handleListPresentationComments,
} from '../google-slides/toolHandlers.js';

const noopLog = { info: () => {}, error: () => {} };

function mockSlides(overrides: any = {}) {
  return {
    presentations: {
      create: mock.fn(async () => ({
        data: { presentationId: 'pres1', title: 'Test Presentation' },
      })),
      get: mock.fn(async () => ({
        data: {
          presentationId: 'pres1',
          title: 'Test Presentation',
          slides: [
            {
              objectId: 'slide1',
              pageElements: [
                {
                  objectId: 'shape1',
                  shape: {
                    shapeType: 'TEXT_BOX',
                    text: {
                      textElements: [
                        { textRun: { content: 'Hello ' } },
                        { textRun: { content: 'World' } },
                      ],
                    },
                  },
                },
              ],
            },
            { objectId: 'slide2', pageElements: [] },
          ],
          pageSize: {
            width: { magnitude: 9144000, unit: 'EMU' },
            height: { magnitude: 6858000, unit: 'EMU' },
          },
        },
      })),
      batchUpdate: mock.fn(async () => ({
        data: {
          presentationId: 'pres1',
          replies: [{ createSlide: { objectId: 'newSlide1' } }],
        },
      })),
      pages: {
        get: mock.fn(async () => ({
          data: {
            objectId: 'slide1',
            pageType: 'SLIDE',
            pageElements: [
              {
                objectId: 'shape1',
                shape: {
                  shapeType: 'TEXT_BOX',
                  text: {
                    textElements: [
                      { textRun: { content: 'Slide title' } },
                    ],
                  },
                },
                size: {
                  width: { magnitude: 300, unit: 'PT' },
                  height: { magnitude: 50, unit: 'PT' },
                },
              },
              {
                objectId: 'table1',
                table: {
                  rows: 2,
                  columns: 2,
                  tableRows: [
                    {
                      tableCells: [
                        { text: { textElements: [{ textRun: { content: 'A1' } }] } },
                        { text: { textElements: [{ textRun: { content: 'B1' } }] } },
                      ],
                    },
                    {
                      tableCells: [
                        { text: { textElements: [{ textRun: { content: 'A2' } }] } },
                        { text: { textElements: [{ textRun: { content: 'B2' } }] } },
                      ],
                    },
                  ],
                },
              },
              { objectId: 'line1', line: {} },
              {
                objectId: 'img1',
                image: { sourceUrl: 'https://example.com/img.png' },
              },
            ],
          },
        })),
        getThumbnail: mock.fn(async () => ({
          data: {
            contentUrl: 'https://lh3.google.com/thumb123',
            width: 800,
            height: 600,
          },
        })),
        ...overrides.pages,
      },
      ...overrides.presentations,
    },
  } as any;
}

function mockDrive(overrides: any = {}) {
  return {
    comments: {
      list: mock.fn(async () => ({
        data: {
          comments: [
            {
              author: { displayName: 'Alice' },
              createdTime: '2024-01-01T00:00:00Z',
              content: 'Great slide!',
              resolved: false,
              replies: [
                { author: { displayName: 'Bob' }, content: 'Thanks!' },
              ],
            },
            {
              author: { displayName: 'Charlie' },
              createdTime: '2024-01-02T00:00:00Z',
              content: 'Needs work',
              resolved: true,
              replies: [],
            },
          ],
        },
      })),
      ...overrides.comments,
    },
  } as any;
}

// === getSlidesClient / getDriveClient ===

describe('getSlidesClient', () => {
  it('returns googleSlides when present on session', () => {
    const fakeSlides = { presentations: {} } as any;
    const result = getSlidesClient({ googleSlides: fakeSlides });
    assert.equal(result, fakeSlides);
  });

  it('throws UserError when session is undefined', () => {
    assert.throws(() => getSlidesClient(undefined), { message: /Google Slides client is not available/ });
  });

  it('throws UserError when googleSlides is missing', () => {
    assert.throws(() => getSlidesClient({} as any), { message: /Google Slides client is not available/ });
  });
});

describe('getDriveClient', () => {
  it('returns googleDrive when present on session', () => {
    const fakeDrive = { comments: {} } as any;
    const result = getDriveClient({ googleDrive: fakeDrive });
    assert.equal(result, fakeDrive);
  });

  it('throws UserError when session is undefined', () => {
    assert.throws(() => getDriveClient(undefined), { message: /Google Drive client is not available/ });
  });

  it('throws UserError when googleDrive is missing', () => {
    assert.throws(() => getDriveClient({} as any), { message: /Google Drive client is not available/ });
  });
});

// === extractTextRuns ===

describe('extractTextRuns', () => {
  it('extracts trimmed text from textElements', () => {
    const elements = [
      { textRun: { content: '  Hello  ' } },
      { textRun: { content: 'World' } },
      { endIndex: 5 },  // non-textRun element
    ] as any;
    assert.deepEqual(extractTextRuns(elements), ['Hello', 'World']);
  });

  it('returns empty array for undefined input', () => {
    assert.deepEqual(extractTextRuns(undefined), []);
  });

  it('filters out empty/whitespace-only text runs', () => {
    const elements = [
      { textRun: { content: '   ' } },
      { textRun: { content: '\n' } },
      { textRun: { content: 'Valid' } },
    ] as any;
    assert.deepEqual(extractTextRuns(elements), ['Valid']);
  });
});

// === extractElementTexts ===

describe('extractElementTexts', () => {
  it('extracts text from shape elements', () => {
    const element = {
      shape: {
        text: {
          textElements: [
            { textRun: { content: 'Shape text' } },
          ],
        },
      },
    } as any;
    assert.deepEqual(extractElementTexts(element), ['Shape text']);
  });

  it('extracts text from table elements', () => {
    const element = {
      table: {
        tableRows: [
          {
            tableCells: [
              { text: { textElements: [{ textRun: { content: 'Cell1' } }] } },
              { text: { textElements: [{ textRun: { content: 'Cell2' } }] } },
            ],
          },
        ],
      },
    } as any;
    assert.deepEqual(extractElementTexts(element), ['Cell1', 'Cell2']);
  });

  it('returns empty array for element with no text', () => {
    assert.deepEqual(extractElementTexts({ line: {} } as any), []);
  });

  it('handles element with both shape and table', () => {
    const element = {
      shape: { text: { textElements: [{ textRun: { content: 'S' } }] } },
      table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: 'T' } }] } }] }] },
    } as any;
    assert.deepEqual(extractElementTexts(element), ['S', 'T']);
  });
});

// === handleCreatePresentation ===

describe('handleCreatePresentation', () => {
  it('creates presentation and returns formatted result', async () => {
    const slides = mockSlides();
    const result = await handleCreatePresentation(slides, { title: 'My Deck' }, noopLog);
    assert.ok(result.includes('Presentation created successfully'));
    assert.ok(result.includes('pres1'));
    assert.ok(result.includes('Test Presentation'));
    assert.ok(result.includes('https://docs.google.com/presentation/d/pres1/edit'));
    assert.equal(slides.presentations.create.mock.calls.length, 1);
  });

  it('throws UserError on 403', async () => {
    const slides = mockSlides({
      presentations: {
        create: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleCreatePresentation(slides, { title: 'X' }, noopLog),
      { message: /Permission denied/ }
    );
  });

  it('throws UserError with message on unknown error', async () => {
    const slides = mockSlides({
      presentations: {
        create: mock.fn(async () => { throw new Error('Network down'); }),
      },
    });
    await assert.rejects(
      () => handleCreatePresentation(slides, { title: 'X' }, noopLog),
      { message: /Network down/ }
    );
  });
});

// === handleGetPresentation ===

describe('handleGetPresentation', () => {
  it('returns presentation metadata and text content', async () => {
    const slides = mockSlides();
    const result = await handleGetPresentation(slides, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('**Presentation:** Test Presentation'));
    assert.ok(result.includes('**Slides:** 2'));
    assert.ok(result.includes('slide1'));
    assert.ok(result.includes('slide2'));
    assert.ok(result.includes('**Dimensions:**'));
    assert.ok(result.includes('Hello | World'));
  });

  it('handles presentation with no slides', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => ({
          data: { presentationId: 'pres1', title: 'Empty', slides: [] },
        })),
      },
    });
    const result = await handleGetPresentation(slides, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('**Slides:** 0'));
  });

  it('handles presentation without pageSize', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => ({
          data: { presentationId: 'pres1', title: 'No Size', slides: [] },
        })),
      },
    });
    const result = await handleGetPresentation(slides, { presentationId: 'pres1' }, noopLog);
    assert.ok(!result.includes('**Dimensions:**'));
  });

  it('throws UserError on 404', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPresentation(slides, { presentationId: 'bad' }, noopLog),
      { message: /Presentation not found/ }
    );
  });

  it('throws UserError on 403', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPresentation(slides, { presentationId: 'x' }, noopLog),
      { message: /Permission denied/ }
    );
  });

  it('throws generic UserError on unknown error code', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => { const e: any = new Error('Server error'); e.code = 500; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPresentation(slides, { presentationId: 'x' }, noopLog),
      { message: /Failed to get presentation.*Server error/ }
    );
  });

  it('extracts text from slides with table elements', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => ({
          data: {
            presentationId: 'pres1',
            title: 'With Table',
            slides: [{
              objectId: 's1',
              pageElements: [{
                table: {
                  tableRows: [{
                    tableCells: [
                      { text: { textElements: [{ textRun: { content: 'Cell A' } }] } },
                    ],
                  }],
                },
              }],
            }],
          },
        })),
      },
    });
    const result = await handleGetPresentation(slides, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('Cell A'));
  });

  it('skips slides with no text content', async () => {
    const slides = mockSlides({
      presentations: {
        get: mock.fn(async () => ({
          data: {
            presentationId: 'pres1',
            title: 'Empty Text',
            slides: [{
              objectId: 's1',
              pageElements: [{ line: {} }],
            }],
          },
        })),
      },
    });
    const result = await handleGetPresentation(slides, { presentationId: 'pres1' }, noopLog);
    assert.ok(!result.includes('Slide 1:'));
  });
});

// === handleGetPage ===

describe('handleGetPage', () => {
  it('returns page details with all element types', async () => {
    const slides = mockSlides();
    const result = await handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'slide1' }, noopLog);
    assert.ok(result.includes('**Page:** slide1'));
    assert.ok(result.includes('**Type:** SLIDE'));
    assert.ok(result.includes('**Elements:** 4'));
    assert.ok(result.includes('Type: Shape (TEXT_BOX)'));
    assert.ok(result.includes('Text: Slide title'));
    assert.ok(result.includes('Type: Table (2 x 2)'));
    assert.ok(result.includes('A1 | B1'));
    assert.ok(result.includes('Type: Line'));
    assert.ok(result.includes('Type: Image'));
    assert.ok(result.includes('https://example.com/img.png'));
    assert.ok(result.includes('Size: 300PT x 50PT'));
  });

  it('handles page with no elements', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => ({
          data: { objectId: 'slide1', pageType: 'SLIDE', pageElements: [] },
        })),
      },
    });
    const result = await handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'slide1' }, noopLog);
    assert.ok(result.includes('**Elements:** 0'));
  });

  it('defaults pageType to SLIDE', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => ({
          data: { objectId: 'slide1', pageElements: [] },
        })),
      },
    });
    const result = await handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'slide1' }, noopLog);
    assert.ok(result.includes('**Type:** SLIDE'));
  });

  it('handles shape without text', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => ({
          data: {
            objectId: 'slide1',
            pageElements: [{
              objectId: 'emptyShape',
              shape: { shapeType: 'RECTANGLE' },
            }],
          },
        })),
      },
    });
    const result = await handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'slide1' }, noopLog);
    assert.ok(result.includes('Type: Shape (RECTANGLE)'));
    assert.ok(!result.includes('Text:'));
  });

  it('handles image without sourceUrl', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => ({
          data: {
            objectId: 'slide1',
            pageElements: [{
              objectId: 'img1',
              image: {},
            }],
          },
        })),
      },
    });
    const result = await handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'slide1' }, noopLog);
    assert.ok(result.includes('Type: Image'));
    assert.ok(!result.includes('Source:'));
  });

  it('throws UserError on 404', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'bad' }, noopLog),
      { message: /Page not found/ }
    );
  });

  it('throws UserError on 403', async () => {
    const slides = mockSlides({
      pages: {
        get: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPage(slides, { presentationId: 'pres1', pageObjectId: 'bad' }, noopLog),
      { message: /Permission denied/ }
    );
  });
});

// === handleGetPageThumbnail ===

describe('handleGetPageThumbnail', () => {
  it('returns thumbnail URL and dimensions', async () => {
    const slides = mockSlides();
    const result = await handleGetPageThumbnail(
      slides, { presentationId: 'pres1', pageObjectId: 'slide1', thumbnailSize: 'MEDIUM' }, noopLog
    );
    assert.ok(result.includes('https://lh3.google.com/thumb123'));
    assert.ok(result.includes('800x600'));
    assert.ok(result.includes('slide1'));
  });

  it('throws UserError on 404', async () => {
    const slides = mockSlides({
      pages: {
        getThumbnail: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPageThumbnail(slides, { presentationId: 'pres1', pageObjectId: 'bad', thumbnailSize: 'MEDIUM' }, noopLog),
      { message: /Page not found/ }
    );
  });

  it('throws UserError on 403', async () => {
    const slides = mockSlides({
      pages: {
        getThumbnail: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleGetPageThumbnail(slides, { presentationId: 'pres1', pageObjectId: 's1', thumbnailSize: 'LARGE' }, noopLog),
      { message: /Permission denied/ }
    );
  });

  it('throws generic UserError on unknown error', async () => {
    const slides = mockSlides({
      pages: {
        getThumbnail: mock.fn(async () => { throw new Error('Timeout'); }),
      },
    });
    await assert.rejects(
      () => handleGetPageThumbnail(slides, { presentationId: 'pres1', pageObjectId: 's1', thumbnailSize: 'SMALL' }, noopLog),
      { message: /Failed to get thumbnail.*Timeout/ }
    );
  });
});

// === handleBatchUpdatePresentation ===

describe('handleBatchUpdatePresentation', () => {
  it('returns success with reply details', async () => {
    const slides = mockSlides();
    const result = await handleBatchUpdatePresentation(
      slides, { presentationId: 'pres1', requests: [{ createSlide: {} }] }, noopLog
    );
    assert.ok(result.includes('Batch update successful'));
    assert.ok(result.includes('1 request(s) applied'));
    assert.ok(result.includes('newSlide1'));
  });

  it('handles empty replies', async () => {
    const slides = mockSlides({
      presentations: {
        batchUpdate: mock.fn(async () => ({ data: { presentationId: 'pres1', replies: [{}] } })),
      },
    });
    const result = await handleBatchUpdatePresentation(
      slides, { presentationId: 'pres1', requests: [{ deleteObject: { objectId: 'x' } }] }, noopLog
    );
    assert.ok(result.includes('Batch update successful'));
    assert.ok(!result.includes('{}'));
  });

  it('throws UserError on 404', async () => {
    const slides = mockSlides({
      presentations: {
        batchUpdate: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
      },
    });
    await assert.rejects(
      () => handleBatchUpdatePresentation(slides, { presentationId: 'bad', requests: [] }, noopLog),
      { message: /Presentation not found/ }
    );
  });

  it('throws UserError on 400', async () => {
    const slides = mockSlides({
      presentations: {
        batchUpdate: mock.fn(async () => { const e: any = new Error('Bad request body'); e.code = 400; throw e; }),
      },
    });
    await assert.rejects(
      () => handleBatchUpdatePresentation(slides, { presentationId: 'pres1', requests: [{ bad: true }] }, noopLog),
      { message: /Invalid request/ }
    );
  });

  it('throws UserError on 403', async () => {
    const slides = mockSlides({
      presentations: {
        batchUpdate: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleBatchUpdatePresentation(slides, { presentationId: 'pres1', requests: [] }, noopLog),
      { message: /Permission denied.*write access/ }
    );
  });
});

// === handleListPresentationComments ===

describe('handleListPresentationComments', () => {
  it('returns formatted comments with replies', async () => {
    const drive = mockDrive();
    const result = await handleListPresentationComments(drive, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('Found 2 comment(s)'));
    assert.ok(result.includes('Alice'));
    assert.ok(result.includes('Great slide!'));
    assert.ok(result.includes('Bob'));
    assert.ok(result.includes('Thanks!'));
    assert.ok(result.includes('Charlie'));
    assert.ok(result.includes('*Resolved*'));
  });

  it('returns message when no comments', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => ({ data: { comments: [] } })),
      },
    });
    const result = await handleListPresentationComments(drive, { presentationId: 'pres1' }, noopLog);
    assert.equal(result, 'No comments found on this presentation.');
  });

  it('handles comments with no replies array', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => ({
          data: {
            comments: [{
              author: { displayName: 'Eve' },
              createdTime: '2024-01-01T00:00:00Z',
              content: 'Solo comment',
              resolved: false,
            }],
          },
        })),
      },
    });
    const result = await handleListPresentationComments(drive, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('Eve'));
    assert.ok(result.includes('Solo comment'));
    assert.ok(!result.includes('**Replies:**'));
  });

  it('throws UserError on 404', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
      },
    });
    await assert.rejects(
      () => handleListPresentationComments(drive, { presentationId: 'bad' }, noopLog),
      { message: /Presentation not found/ }
    );
  });

  it('throws UserError on 403', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }),
      },
    });
    await assert.rejects(
      () => handleListPresentationComments(drive, { presentationId: 'x' }, noopLog),
      { message: /Permission denied/ }
    );
  });

  it('throws generic UserError on unknown error', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => { throw new Error('Rate limited'); }),
      },
    });
    await assert.rejects(
      () => handleListPresentationComments(drive, { presentationId: 'x' }, noopLog),
      { message: /Failed to list comments.*Rate limited/ }
    );
  });

  it('handles comment with missing author', async () => {
    const drive = mockDrive({
      comments: {
        list: mock.fn(async () => ({
          data: {
            comments: [{
              createdTime: '2024-01-01T00:00:00Z',
              content: 'Anonymous comment',
              resolved: false,
            }],
          },
        })),
      },
    });
    const result = await handleListPresentationComments(drive, { presentationId: 'pres1' }, noopLog);
    assert.ok(result.includes('Unknown'));
    assert.ok(result.includes('Anonymous comment'));
  });
});
