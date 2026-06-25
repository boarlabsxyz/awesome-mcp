// Pure helpers for the /api/v1/docs/{documentId} REST handler.
//
// Extracting these out of the route reduces its cognitive complexity to
// under SonarCloud's 15 threshold and lets the doc-rendering / tab-selection
// logic be unit-tested in isolation.

/** Tagged result of selectTabContent — turns the multi-shape branch
 *  inside the handler into a single typed switch. */
export type TabSelection =
  | { kind: 'ok'; content: { body?: unknown } }
  | { kind: 'notFound'; message: string }
  | { kind: 'badRequest'; message: string };

interface TabLike {
  tabProperties?: { tabId?: string };
  documentTab?: { body?: unknown };
  childTabs?: TabLike[];
}

interface DocWithTabs {
  tabs?: TabLike[];
  body?: unknown;
}

export function findTabByIdShallow(tabs: TabLike[] | undefined, tabId: string): TabLike | null {
  if (!tabs || tabs.length === 0) return null;
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const nested = findTabByIdShallow(tab.childTabs, tabId);
    if (nested) return nested;
  }
  return null;
}

export function selectTabContent(doc: DocWithTabs, tabId: string): TabSelection {
  const target = findTabByIdShallow(doc.tabs, tabId);
  if (!target) return { kind: 'notFound', message: `Tab with ID "${tabId}" not found` };
  if (!target.documentTab) return { kind: 'badRequest', message: `Tab "${tabId}" does not have content` };
  return { kind: 'ok', content: { body: target.documentTab.body } };
}

/** Walk paragraphs + tables in a Google Doc body and concatenate textRun
 *  content. Equivalent to what the readGoogleDoc MCP tool emits. */
export function extractDocBodyText(contentSource: { body?: any } | undefined): string {
  let text = '';
  contentSource?.body?.content?.forEach((element: any) => {
    element.paragraph?.elements?.forEach((pe: any) => {
      if (pe.textRun?.content) text += pe.textRun.content;
    });
    element.table?.tableRows?.forEach((row: any) => {
      row.tableCells?.forEach((cell: any) => {
        cell.content?.forEach((cellElement: any) => {
          cellElement.paragraph?.elements?.forEach((pe: any) => {
            if (pe.textRun?.content) text += pe.textRun.content;
          });
        });
      });
    });
  });
  return text;
}

/** Truncate a JSON payload by its serialised character length. Returns either
 *  the payload unchanged or a wrapper carrying the partial string and the
 *  original length. We do not try to JSON.parse the truncated string — a cut
 *  in the middle of a quoted value would throw. The caller is expected to
 *  surface `truncatedJson` as a string so consumers know they got partial
 *  data they must parse themselves. */
export function truncateJsonByLength<T>(
  payload: T,
  maxLength: number,
):
  | { truncated: false; payload: T }
  | { truncated: true; originalLength: number; truncatedJson: string } {
  if (maxLength <= 0) return { truncated: false, payload };
  const serialised = JSON.stringify(payload);
  if (serialised.length <= maxLength) return { truncated: false, payload };
  return {
    truncated: true,
    originalLength: serialised.length,
    truncatedJson: serialised.substring(0, maxLength),
  };
}
