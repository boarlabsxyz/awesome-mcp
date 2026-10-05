// src/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { google, docs_v1, drive_v3, sheets_v4 } from 'googleapis';
import { authorize } from '../auth.js';
import { OAuth2Client } from 'google-auth-library';

// Import types and helpers
import {
DocumentIdParameter,
RangeParameters,
OptionalRangeParameters,
TextFindParameter,
TextStyleParameters,
TextStyleArgs,
ParagraphStyleParameters,
ParagraphStyleArgs,
ApplyTextStyleToolParameters, ApplyTextStyleToolArgs,
ApplyParagraphStyleToolParameters, ApplyParagraphStyleToolArgs,
SharedDriveParameters,
NotImplementedError,
BatchOperationSchema,
BatchOperation
} from '../types.js';
import * as GDocsHelpers from './apiHelpers.js';
// Write-tool schemas and ops live in their own modules so the REST data plane can
// import them: this file is the application entry point (it imports createWebApp),
// so webServer.ts cannot import it back.
import {
  addCommentSchema,
  appendToGoogleDocSchema,
  applyParagraphStyleSchema,
  applyTextStyleSchema,
  batchUpdateDocSchema,
  deleteCommentSchema,
  deleteRangeSchema,
  findAndReplaceSchema,
  formatMatchingTextSchema,
  importDocxSchema,
  importToGoogleDocSchema,
  insertImageFromUrlSchema,
  insertLocalImageSchema,
  insertPageBreakSchema,
  insertTableSchema,
  insertTextSchema,
  replyToCommentSchema,
  resolveCommentSchema,
} from './writeSchemas.js';
import {
  performAddComment,
  performAppendToGoogleDoc,
  performApplyParagraphStyle,
  performApplyTextStyle,
  performBatchUpdateDoc,
  performDeleteComment,
  performDeleteRange,
  performFindAndReplace,
  performFormatMatchingText,
  performImportDocx,
  performImportToGoogleDoc,
  performInsertImageFromUrl,
  performInsertLocalImage,
  performInsertPageBreak,
  performInsertTable,
  performInsertText,
  performReplyToComment,
  performResolveComment,
} from './writeOps.js';
import { handleDriveError } from '../google-drive/driveHelpers.js';
import {
  handleListGoogleDocs,
  handleSearchGoogleDocs,
  handleGetRecentGoogleDocs,
  handleExportDocToPdf,
} from '../google-drive/toolHandlers.js';

// Multi-user imports
import { UserSession } from '../userSession.js';
import { loadUsers } from '../userStore.js';
import { initDatabase, closeDatabase } from '../db.js';
import { createWebApp } from '../website/webServer.js';
import { assertImagePublicBaseUrlConfigured } from '../images/imageBlobStore.js';
import { seedDefaultCatalogs } from '../mcpCatalogStore.js';
import { calendarServer } from '../google-calendar/server.js';
import { sheetsServer } from '../google-sheets/server.js';
import { gmailServer } from '../google-gmail/server.js';
import { slidesServer } from '../google-slides/server.js';
import { driveServer } from '../google-drive/server.js';
import { clickUpServer } from '../clickup/server.js';
import { slackBotServer } from '../slack/server.js';
import { slackUserServer } from '../slack-user/server.js';
import { outlineServer } from '../outline/server.js';
import { peopleForceServer } from '../peopleforce/server.js';
import { peopleForceV4Server } from '../peopleforce-v4/server.js';
import { hubspotServer } from '../hubspot/server.js';
import { browserbaseServer }   from '../browserbase/server.js';
import { redmineServer } from '../redmine/server.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

// Global clients for stdio (single-user) mode
let authClient: OAuth2Client | null = null;
let globalDocsClient: docs_v1.Docs | null = null;
let globalDriveClient: drive_v3.Drive | null = null;
let globalSheetsClient: sheets_v4.Sheets | null = null;

// --- Initialization (stdio single-user mode only) ---
async function initializeGoogleClient() {
if (globalDocsClient && globalDriveClient && globalSheetsClient) return { authClient, googleDocs: globalDocsClient, googleDrive: globalDriveClient, googleSheets: globalSheetsClient };
if (!authClient) {
try {
console.error("Attempting to authorize Google API client...");
const client = await authorize();
authClient = client;
globalDocsClient = google.docs({ version: 'v1', auth: authClient });
globalDriveClient = google.drive({ version: 'v3', auth: authClient });
globalSheetsClient = google.sheets({ version: 'v4', auth: authClient });
console.error("Google API client authorized successfully.");
} catch (error) {
console.error("FATAL: Failed to initialize Google API client:", error);
authClient = null;
globalDocsClient = null;
globalDriveClient = null;
globalSheetsClient = null;
throw new Error("Google client initialization failed. Cannot start server tools.");
}
}
if (authClient && !globalDocsClient) {
globalDocsClient = google.docs({ version: 'v1', auth: authClient });
}
if (authClient && !globalDriveClient) {
globalDriveClient = google.drive({ version: 'v3', auth: authClient });
}
if (authClient && !globalSheetsClient) {
globalSheetsClient = google.sheets({ version: 'v4', auth: authClient });
}

if (!globalDocsClient || !globalDriveClient || !globalSheetsClient) {
throw new Error("Google Docs, Drive, and Sheets clients could not be initialized.");
}

return { authClient, googleDocs: globalDocsClient, googleDrive: globalDriveClient, googleSheets: globalSheetsClient };
}

// Set up process-level unhandled error/rejection handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit process, just log the error and continue
  // This will catch timeout errors that might otherwise crash the server
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
  // Don't exit process, just log the error and continue
});

// MCP slug for this server instance (set via environment variable or defaults to google-docs)
const MCP_SLUG = process.env.MCP_SLUG || 'google-docs';

const server = new FastMCP<UserSession>({
  name: 'Ultimate Google Docs & Sheets MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(MCP_SLUG),
});

import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { sliceSafe, sanitizeDocText, assertTransportSafe, stringifySafe } from './textSafety.js';
registerMintRestBearerForCurl(server);
registerListRestEndpoints(server);

// --- Helper to get Docs client within tools ---
// In multi-user mode, session provides the client; in stdio mode, falls back to global client
async function getDocsClient(session?: UserSession) {
if (session?.googleDocs) return session.googleDocs;
const { googleDocs: docs } = await initializeGoogleClient();
if (!docs) {
throw new UserError("Google Docs client is not initialized. Authentication might have failed during startup or lost connection.");
}
return docs;
}

// --- Helper to get Drive client within tools ---
async function getDriveClient(session?: UserSession) {
if (session?.googleDrive) return session.googleDrive;
const { googleDrive: drive } = await initializeGoogleClient();
if (!drive) {
throw new UserError("Google Drive client is not initialized. Authentication might have failed during startup or lost connection.");
}
return drive;
}

// Helper to get the auth client for direct google API usage (comment tools)
function getAuthClient(session?: UserSession): OAuth2Client {
if (session?.oauthClient) return session.oauthClient;
if (authClient) return authClient as unknown as OAuth2Client;
throw new UserError("Not authenticated. Provide an API key or configure credentials.");
}

// === HELPER FUNCTIONS ===

/**
 * Converts Google Docs JSON structure to Markdown format
 */
function convertDocsJsonToMarkdown(docData: any): string {
    let markdown = '';

    if (!docData.body?.content) {
        return 'Document appears to be empty.';
    }

    docData.body.content.forEach((element: any) => {
        if (element.paragraph) {
            markdown += convertParagraphToMarkdown(element.paragraph);
        } else if (element.table) {
            markdown += convertTableToMarkdown(element.table);
        } else if (element.sectionBreak) {
            markdown += '\n---\n\n'; // Section break as horizontal rule
        }
    });

    return markdown.trim();
}

/**
 * Converts a paragraph element to markdown
 */
function convertParagraphToMarkdown(paragraph: any): string {
    let text = '';
    let isHeading = false;
    let headingLevel = 0;
    let isList = false;
    let listType = '';

    // Check paragraph style for headings and lists
    if (paragraph.paragraphStyle?.namedStyleType) {
        const styleType = paragraph.paragraphStyle.namedStyleType;
        if (styleType.startsWith('HEADING_')) {
            isHeading = true;
            headingLevel = parseInt(styleType.replace('HEADING_', ''));
        } else if (styleType === 'TITLE') {
            isHeading = true;
            headingLevel = 1;
        } else if (styleType === 'SUBTITLE') {
            isHeading = true;
            headingLevel = 2;
        }
    }

    // Check for bullet lists
    if (paragraph.bullet) {
        isList = true;
        listType = paragraph.bullet.listId ? 'bullet' : 'bullet';
    }

    // Process text elements
    if (paragraph.elements) {
        paragraph.elements.forEach((element: any) => {
            if (element.textRun) {
                text += convertTextRunToMarkdown(element.textRun);
            }
        });
    }

    // Format based on style
    if (isHeading && text.trim()) {
        const hashes = '#'.repeat(Math.min(headingLevel, 6));
        return `${hashes} ${text.trim()}\n\n`;
    } else if (isList && text.trim()) {
        return `- ${text.trim()}\n`;
    } else if (text.trim()) {
        return `${text.trim()}\n\n`;
    }

    return '\n'; // Empty paragraph
}

/**
 * Converts a text run to markdown with formatting
 */
function convertTextRunToMarkdown(textRun: any): string {
    let text = textRun.content || '';

    if (textRun.textStyle) {
        const style = textRun.textStyle;

        // Apply formatting
        if (style.bold && style.italic) {
            text = `***${text}***`;
        } else if (style.bold) {
            text = `**${text}**`;
        } else if (style.italic) {
            text = `*${text}*`;
        }

        if (style.underline && !style.link) {
            // Markdown doesn't have native underline, use HTML
            text = `<u>${text}</u>`;
        }

        if (style.strikethrough) {
            text = `~~${text}~~`;
        }

        if (style.link?.url) {
            text = `[${text}](${style.link.url})`;
        }
    }

    return text;
}

/**
 * Converts a table to markdown format
 */
function convertTableToMarkdown(table: any): string {
    if (!table.tableRows || table.tableRows.length === 0) {
        return '';
    }

    let markdown = '\n';
    let isFirstRow = true;

    table.tableRows.forEach((row: any) => {
        if (!row.tableCells) return;

        let rowText = '|';
        row.tableCells.forEach((cell: any) => {
            let cellText = '';
            if (cell.content) {
                cell.content.forEach((element: any) => {
                    if (element.paragraph?.elements) {
                        element.paragraph.elements.forEach((pe: any) => {
                            if (pe.textRun?.content) {
                                cellText += pe.textRun.content.replace(/\n/g, ' ').trim();
                            }
                        });
                    }
                });
            }
            rowText += ` ${cellText} |`;
        });

        markdown += rowText + '\n';

        // Add header separator after first row
        if (isFirstRow) {
            let separator = '|';
            for (let i = 0; i < row.tableCells.length; i++) {
                separator += ' --- |';
            }
            markdown += separator + '\n';
            isFirstRow = false;
        }
    });

    return markdown + '\n';
}

// === TOOL DEFINITIONS ===

// --- Drive discovery tools (require full Drive scope) ---

server.addTool({
  name: 'listGoogleDocs',
  annotations: { readOnlyHint: true },
  description: 'Lists Google Documents from your Google Drive and shared drives with optional filtering.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of documents to return (1-100).'),
    query: z.string().optional().describe('Search query to filter documents by name or content.'),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional().default('modifiedTime').describe('Sort order for results.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleListGoogleDocs(await getDriveClient(session), args, log),
});

server.addTool({
  name: 'searchGoogleDocs',
  annotations: { readOnlyHint: true },
  description: 'Searches for Google Documents by name, content, or other criteria across My Drive and shared drives.',
  parameters: z.object({
    searchQuery: z.string().min(1).describe('Search term to find in document names or content.'),
    searchIn: z.enum(['name', 'content', 'both']).optional().default('both').describe('Where to search: document names, content, or both.'),
    maxResults: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of results to return.'),
    modifiedAfter: z.string().optional().describe('Only return documents modified after this date (ISO 8601 format, e.g., "2024-01-01").'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleSearchGoogleDocs(await getDriveClient(session), args, log),
});

server.addTool({
  name: 'getRecentGoogleDocs',
  annotations: { readOnlyHint: true },
  description: 'Gets the most recently modified Google Documents from My Drive and shared drives.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of recent documents to return.'),
    daysBack: z.number().int().min(1).max(365).optional().default(30).describe('Only show documents modified within this many days.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleGetRecentGoogleDocs(await getDriveClient(session), args, log),
});

server.addTool({
  name: 'exportDocToPdf',
  annotations: { readOnlyHint: false },
  description: 'Exports a Google Doc as a PDF file and saves it to Google Drive. Returns the PDF file ID, name, and link.',
  parameters: z.object({
    documentId: z.string().describe('The ID of the Google Document to export.'),
    pdfFilename: z.string().optional().describe('Custom filename for the PDF (without extension). Defaults to the document title.'),
    folderId: z.string().optional().describe('Optional Drive folder ID to save the PDF in.'),
  }),
  execute: async (args, { log, session }) => handleExportDocToPdf(await getDriveClient(session), args, log),
});

// --- Foundational Tools ---

server.addTool({
name: 'readGoogleDoc',
annotations: { readOnlyHint: true },
description: 'Reads the content of a specific Google Document, optionally returning structured data.',
parameters: DocumentIdParameter.extend({
format: z.enum(['text', 'json', 'markdown']).optional().default('text')
.describe("Output format: 'text' (plain text), 'json' (raw API structure, complex), 'markdown' (experimental conversion)."),
maxLength: z.number().optional().describe('Maximum character limit for text output. If not specified, returns full document content. Use this to limit very large documents.'),
tabId: z.string().optional().describe('The ID of the specific tab to read. If not specified, reads the first tab (or legacy document.body for documents without tabs).')
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Reading Google Doc: ${args.documentId}, Format: ${args.format}${args.tabId ? `, Tab: ${args.tabId}` : ''}`);

    try {
        // Determine if we need tabs content
        const needsTabsContent = !!args.tabId;

        // The text projection must name tables as well as paragraphs. It used to
        // request paragraphs only, which meant the table-walking branch below
        // could never fire and every table's text was silently missing from
        // `format: 'text'` — a doc built out of tables read as nearly empty.
        const fields = args.format === 'json' || args.format === 'markdown'
            ? '*' // Get everything for structure analysis
            : 'body(content(paragraph(elements(textRun(content))),table(tableRows(tableCells(content(paragraph(elements(textRun(content)))))))))';

        const res = await docs.documents.get({
            documentId: args.documentId,
            includeTabsContent: needsTabsContent,
            fields: needsTabsContent ? '*' : fields, // Get full document if using tabs
        });
        log.info(`Fetched doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);

        // If tabId is specified, find the specific tab
        let contentSource: any;
        if (args.tabId) {
            const targetTab = GDocsHelpers.findTabById(res.data, args.tabId);
            if (!targetTab) {
                throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
            }
            if (!targetTab.documentTab) {
                throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
            }
            contentSource = { body: targetTab.documentTab.body };
            log.info(`Using content from tab: ${targetTab.tabProperties?.title || 'Untitled'}`);
        } else {
            // Use the document body (backward compatible)
            contentSource = res.data;
        }

        if (args.format === 'json') {
            // stringifySafe, not JSON.stringify: once serialised, a lone
            // surrogate in a textRun has become the escape `\udXXX`, which
            // assertTransportSafe can no longer see and strict parsers reject.
            const jsonContent = stringifySafe(contentSource, 2);
            // Never slice serialised JSON and hand back the fragment: the result
            // is a dangling string or brace, so anything that parses it fails
            // with "EOF while parsing a string" — a truncation bug that reads
            // like a transport bug. Wrap the partial in a valid envelope
            // instead, the same contract truncateJsonByLength uses for the REST
            // sibling (src/website/docContent.ts): the fragment travels as a
            // *string field*, so the response as a whole always parses.
            if (args.maxLength && jsonContent.length > args.maxLength) {
                return JSON.stringify({
                    truncated: true,
                    originalLength: jsonContent.length,
                    note: `Showing the first ${args.maxLength} characters of ${jsonContent.length}. "truncatedJson" is a fragment and is NOT itself parseable — raise maxLength or omit it to get the whole document.`,
                    truncatedJson: sliceSafe(jsonContent, args.maxLength),
                }, null, 2);
            }
            return jsonContent;
        }

        if (args.format === 'markdown') {
            const markdownContent = sanitizeDocText(convertDocsJsonToMarkdown(contentSource));
            const totalLength = markdownContent.length;
            log.info(`Generated markdown: ${totalLength} characters`);

            // Apply length limit to markdown if specified
            if (args.maxLength && totalLength > args.maxLength) {
                const truncatedContent = sliceSafe(markdownContent, args.maxLength);
                return assertTransportSafe(
                    `${truncatedContent}\n\n... [Markdown truncated to ${args.maxLength} chars of ${totalLength} total. Use maxLength parameter to adjust limit or remove it to get full content.]`,
                    { documentId: args.documentId, what: 'markdown' },
                );
            }

            return assertTransportSafe(markdownContent, { documentId: args.documentId, what: 'markdown' });
        }

        // Default: Text format - extract all text content
        let textContent = '';
        let elementCount = 0;

        // Process all content elements from contentSource
        contentSource.body?.content?.forEach((element: any) => {
            elementCount++;

            // Handle paragraphs
            if (element.paragraph?.elements) {
                element.paragraph.elements.forEach((pe: any) => {
                    if (pe.textRun?.content) {
                        textContent += pe.textRun.content;
                    }
                });
            }

            // Handle tables
            if (element.table?.tableRows) {
                element.table.tableRows.forEach((row: any) => {
                    row.tableCells?.forEach((cell: any) => {
                        cell.content?.forEach((cellElement: any) => {
                            cellElement.paragraph?.elements?.forEach((pe: any) => {
                                if (pe.textRun?.content) {
                                    textContent += pe.textRun.content;
                                }
                            });
                        });
                    });
                });
            }
        });

        if (!textContent.trim()) return "Document found, but appears empty.";

        // Google Docs emits U+000B for shift-enter soft breaks and private-use
        // characters as inline-object placeholders; neither survives a strict
        // JSON reader on the other end.
        textContent = sanitizeDocText(textContent);

        const totalLength = textContent.length;
        log.info(`Document contains ${totalLength} characters across ${elementCount} elements`);
        log.info(`maxLength parameter: ${args.maxLength || 'not specified'}`);

        // Apply length limit only if specified
        if (args.maxLength && totalLength > args.maxLength) {
            // sliceSafe, not substring: a cut between the halves of a surrogate
            // pair (any emoji, most CJK extensions) leaves a lone surrogate that
            // the caller's JSON parser rejects.
            const truncatedContent = sliceSafe(textContent, args.maxLength);
            log.info(`Truncating content from ${totalLength} to ${args.maxLength} characters`);
            return assertTransportSafe(
                `Content (truncated to ${args.maxLength} chars of ${totalLength} total):\n---\n${truncatedContent}\n\n... [Document continues for ${totalLength - args.maxLength} more characters. Use maxLength parameter to adjust limit or remove it to get full content.]`,
                { documentId: args.documentId, what: 'text' },
            );
        }

        // Return full content
        const fullResponse = assertTransportSafe(
            `Content (${totalLength} characters):\n---\n${textContent}`,
            { documentId: args.documentId, what: 'text' },
        );
        const responseLength = fullResponse.length;
        log.info(`Returning full content: ${responseLength} characters in response (${totalLength} content + ${responseLength - totalLength} metadata)`);

        return fullResponse;

    } catch (error: any) {
         log.error(`Error reading doc ${args.documentId}: ${error.message || error}`);
         log.error(`Error details: ${JSON.stringify(error.response?.data || error)}`);
         // Handle errors thrown by helpers or API directly
         if (error instanceof UserError) throw error;
         if (error instanceof NotImplementedError) throw error;
         // Generic fallback for API errors not caught by helpers
          if (error.code === 404) throw new UserError(`Doc not found (ID: ${args.documentId}).`);
          if (error.code === 403) throw new UserError(`Permission denied for doc (ID: ${args.documentId}).`);
         // Extract detailed error information from Google API response
         const errorDetails = error.response?.data?.error?.message || error.message || 'Unknown error';
         const errorCode = error.response?.data?.error?.code || error.code;
         throw new UserError(`Failed to read doc: ${errorDetails}${errorCode ? ` (Code: ${errorCode})` : ''}`);
    }

},
});

server.addTool({
name: 'listDocumentTabs',
annotations: { readOnlyHint: true },
description: 'Lists all tabs in a Google Document, including their hierarchy, IDs, and structure.',
parameters: DocumentIdParameter.extend({
  includeContent: z.boolean().optional().default(false)
    .describe('Whether to include a content summary for each tab (character count).')
}),
execute: async (args, { log, session }) => {
  const docs = await getDocsClient(session);
  log.info(`Listing tabs for document: ${args.documentId}`);

  try {
    // Get document with tabs structure
    const res = await docs.documents.get({
      documentId: args.documentId,
      includeTabsContent: true,
      // Only get essential fields for tab listing
      fields: args.includeContent
        ? 'title,tabs'  // Get all tab data if we need content summary
        : 'title,tabs(tabProperties,childTabs)'  // Otherwise just structure
    });

    const docTitle = res.data.title || 'Untitled Document';

    // Get all tabs in a flat list with hierarchy info
    const allTabs = GDocsHelpers.getAllTabs(res.data);

    if (allTabs.length === 0) {
      // Shouldn't happen with new structure, but handle edge case
      return `Document "${docTitle}" appears to have no tabs (unexpected).`;
    }

    // Check if it's a single-tab or multi-tab document
    const isSingleTab = allTabs.length === 1;

    // Format the output
    let result = `**Document:** "${docTitle}"\n`;
    result += `**Total tabs:** ${allTabs.length}`;
    result += isSingleTab ? ' (single-tab document)\n\n' : '\n\n';

    if (!isSingleTab) {
      result += `**Tab Structure:**\n`;
      result += `${'─'.repeat(50)}\n\n`;
    }

    allTabs.forEach((tab: GDocsHelpers.TabWithLevel, index: number) => {
      const level = tab.level;
      const tabProperties = tab.tabProperties || {};
      const indent = '  '.repeat(level);

      // For single tab documents, show simplified info
      if (isSingleTab) {
        result += `**Default Tab:**\n`;
        result += `- Tab ID: ${tabProperties.tabId || 'Unknown'}\n`;
        result += `- Title: ${tabProperties.title || '(Untitled)'}\n`;
      } else {
        // For multi-tab documents, show hierarchy
        const prefix = level > 0 ? '└─ ' : '';
        result += `${indent}${prefix}**Tab ${index + 1}:** "${tabProperties.title || 'Untitled Tab'}"\n`;
        result += `${indent}   - ID: ${tabProperties.tabId || 'Unknown'}\n`;
        result += `${indent}   - Index: ${tabProperties.index !== undefined ? tabProperties.index : 'N/A'}\n`;

        if (tabProperties.parentTabId) {
          result += `${indent}   - Parent Tab ID: ${tabProperties.parentTabId}\n`;
        }
      }

      // Optionally include content summary
      if (args.includeContent && tab.documentTab) {
        const textLength = GDocsHelpers.getTabTextLength(tab.documentTab);
        const contentInfo = textLength > 0
          ? `${textLength.toLocaleString()} characters`
          : 'Empty';
        result += `${indent}   - Content: ${contentInfo}\n`;
      }

      if (!isSingleTab) {
        result += '\n';
      }
    });

    // Add usage hint for multi-tab documents
    if (!isSingleTab) {
      result += `\n💡 **Tip:** Use tab IDs with other tools to target specific tabs.`;
    }

    return result;

  } catch (error: any) {
    log.error(`Error listing tabs for doc ${args.documentId}: ${error.message || error}`);
    if (error.code === 404) throw new UserError(`Document not found (ID: ${args.documentId}).`);
    if (error.code === 403) throw new UserError(`Permission denied for document (ID: ${args.documentId}).`);
    throw new UserError(`Failed to list tabs: ${error.message || 'Unknown error'}`);
  }
}
});

server.addTool({
  name: 'appendToGoogleDoc',
  annotations: { readOnlyHint: false },
  description: 'Appends text to the very end of a specific Google Document or tab. Equivalent to insertText at the document end; use this when you do not know the end index.',
  parameters: appendToGoogleDocSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Appending to Google Doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
    try {
      await performAppendToGoogleDoc(docs, args);
      return `Successfully appended text to ${args.tabId ? `tab ${args.tabId} in ` : ''}document ${args.documentId}.`;
    } catch (error: any) {
      log.error(`Error appending to doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      if (error instanceof NotImplementedError) throw error;
      throw new UserError(`Failed to append to doc: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'insertText',
  annotations: { readOnlyHint: false },
  description: 'Inserts text at a specific 1-based index within the document body or a specific tab. For end-of-document inserts where you do not have an index, prefer appendToGoogleDoc.',
  parameters: insertTextSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Inserting text in doc ${args.documentId} at index ${args.index}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
    try {
      await performInsertText(docs, args);
      return `Successfully inserted text at index ${args.index}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
    } catch (error: any) {
      log.error(`Error inserting text in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to insert text: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'deleteRange',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Deletes content within a specified range (start index inclusive, end index exclusive) from the document or a specific tab.',
  parameters: deleteRangeSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Deleting range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
    try {
      await performDeleteRange(docs, args);
      return `Successfully deleted content in range ${args.startIndex}-${args.endIndex}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
    } catch (error: any) {
      log.error(`Error deleting range in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to delete range: ${error.message || 'Unknown error'}`);
    }
  },
});

// --- Advanced Formatting & Styling Tools ---

server.addTool({
  name: 'applyTextStyle',
  annotations: { readOnlyHint: false },
  description: 'Applies character-level formatting to a specific range or found text. Supported style keys: bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, backgroundColor, link.',
  parameters: applyTextStyleSchema,
  execute: async (args: ApplyTextStyleToolArgs, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Applying text style in doc ${args.documentId}. Target: ${JSON.stringify(args.target)}, Style: ${JSON.stringify(args.style)}`);
    try {
      const { startIndex, endIndex, fields } = await performApplyTextStyle(docs, args);
      if (!fields) return "No valid text styling options were provided.";
      return `Successfully applied text style (${fields.join(', ')}) to range ${startIndex}-${endIndex}.`;
    } catch (error: any) {
      log.error(`Error applying text style in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      if (error instanceof NotImplementedError) throw error;
      throw new UserError(`Failed to apply text style: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'applyParagraphStyle',
  annotations: { readOnlyHint: false },
  description: 'Applies paragraph-level formatting (alignment, spacing, named styles like Heading 1) to the paragraph(s) containing specific text, an index, or a range.',
  parameters: applyParagraphStyleSchema,
  execute: async (args: ApplyParagraphStyleToolArgs, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Applying paragraph style to document ${args.documentId}`);
    log.info(`Style options: ${JSON.stringify(args.style)}`);
    log.info(`Target specification: ${JSON.stringify(args.target)}`);
    try {
      const { fields } = await performApplyParagraphStyle(docs, args);
      if (!fields) return "No valid paragraph styling options were provided.";
      return `Successfully applied paragraph styles (${fields.join(', ')}) to the paragraph.`;
    } catch (error: any) {
      log.error(`Error applying paragraph style in doc ${args.documentId}:`);
      log.error(error.stack || error.message || error);
      if (error instanceof UserError) throw error;
      if (error instanceof NotImplementedError) throw error;
      throw new UserError(`Failed to apply paragraph style: ${error.message || 'Unknown error'}`);
    }
  },
});

// --- Structure & Content Tools ---

server.addTool({
  name: 'insertTable',
  annotations: { readOnlyHint: false },
  description: 'Inserts a new table with the specified dimensions at a given index.',
  parameters: insertTableSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Inserting ${args.rows}x${args.columns} table in doc ${args.documentId} at index ${args.index}`);
    try {
      await performInsertTable(docs, args);
      return `Successfully inserted a ${args.rows}x${args.columns} table at index ${args.index}.`;
    } catch (error: any) {
      log.error(`Error inserting table in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to insert table: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
name: 'editTableCell',
annotations: { readOnlyHint: false },
description: 'NOT IMPLEMENTED — always throws. Editing table cells requires non-trivial index calculation that has not been built yet. Use batchUpdateDoc with raw insert/delete requests if you need to modify table contents.',
parameters: DocumentIdParameter.extend({
tableStartIndex: z.number().int().min(1).describe("The starting index of the TABLE element itself (tricky to find, may require reading structure first)."),
rowIndex: z.number().int().min(0).describe("Row index (0-based)."),
columnIndex: z.number().int().min(0).describe("Column index (0-based)."),
textContent: z.string().optional().describe("Optional: New text content for the cell. Replaces existing content."),
// Combine basic styles for simplicity here. More advanced cell styling might need separate tools.
textStyle: TextStyleParameters.optional().describe("Optional: Text styles to apply."),
paragraphStyle: ParagraphStyleParameters.optional().describe("Optional: Paragraph styles (like alignment) to apply."),
// cellBackgroundColor: z.string().optional()... // Cell-specific styles are complex
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Editing cell (${args.rowIndex}, ${args.columnIndex}) in table starting at ${args.tableStartIndex}, doc ${args.documentId}`);

        // TODO: Implement complex logic
        // 1. Find the cell's content range based on tableStartIndex, rowIndex, columnIndex. This is NON-TRIVIAL.
        //    Requires getting the document, finding the table element, iterating through rows/cells to calculate indices.
        // 2. If textContent is provided, generate a DeleteContentRange request for the cell's current content.
        // 3. Generate an InsertText request for the new textContent at the cell's start index.
        // 4. If textStyle is provided, generate UpdateTextStyle requests for the new text range.
        // 5. If paragraphStyle is provided, generate UpdateParagraphStyle requests for the cell's paragraph range.
        // 6. Execute batch update.

        log.error("editTableCell is not implemented due to complexity of finding cell indices.");
        throw new NotImplementedError("Editing table cells is complex and not yet implemented.");
        // return `Edit request for cell (${args.rowIndex}, ${args.columnIndex}) submitted (Not Implemented).`;
    }

});

server.addTool({
  name: 'insertPageBreak',
  annotations: { readOnlyHint: false },
  description: 'Inserts a page break at the specified index.',
  parameters: insertPageBreakSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Inserting page break in doc ${args.documentId} at index ${args.index}`);
    try {
      await performInsertPageBreak(docs, args);
      return `Successfully inserted page break at index ${args.index}.`;
    } catch (error: any) {
      log.error(`Error inserting page break in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to insert page break: ${error.message || 'Unknown error'}`);
    }
  },
});

// --- Image Insertion Tools ---

server.addTool({
  name: 'insertImageFromUrl',
  annotations: { readOnlyHint: false },
  description: 'Inserts an inline image into a Google Document from a publicly accessible URL.',
  parameters: insertImageFromUrlSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Inserting image from URL ${args.imageUrl} at index ${args.index} in doc ${args.documentId}`);
    try {
      await performInsertImageFromUrl(docs, args);
      const sizeInfo = args.width && args.height ? ` with size ${args.width}x${args.height}pt` : '';
      return `Successfully inserted image from URL at index ${args.index}${sizeInfo}.`;
    } catch (error: any) {
      log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to insert image: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'insertLocalImage',
  annotations: { readOnlyHint: false },
  description: 'Inserts an image into a Google Document. Provide one of: (1) imageUrl — a public HTTP(S) URL to fetch, (2) driveFileId — ID of an image already in Google Drive, (3) localImagePath — absolute path for local/stdio deployments, or (4) imageBase64 + fileName — base64-encoded content for small images.',
  parameters: insertLocalImageSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    const drive = await getDriveClient(session);
    const imageSource = args.imageUrl || args.driveFileId || args.localImagePath || args.fileName || 'base64 image';
    log.info(`Inserting image ${imageSource} at index ${args.index} in doc ${args.documentId}`);
    try {
      // Opt in to the local-filesystem source only on a stdio deployment, where
      // the caller owns the machine and the file. TRANSPORT is httpStream in the
      // hosted image (see the Dockerfile), so the hosted MCP surface refuses it
      // exactly like the REST plane does.
      const { resolvedImageUrl } = await performInsertLocalImage(docs, drive, args, {
        // Read from the env rather than the TRANSPORT const, which is declared
        // further down the file for the startup path — same value, no
        // forward-reference to reason about.
        allowLocalFilesystem: (process.env.TRANSPORT || 'stdio') === 'stdio',
      });
      const sizeInfo = args.width && args.height ? ` with size ${args.width}x${args.height}pt` : '';
      return `Successfully inserted image at index ${args.index}${sizeInfo}.\nImage URL: ${resolvedImageUrl}`;
    } catch (error: any) {
      log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to insert image: ${error.message || 'Unknown error'}`);
    }
  },
});

// --- Intelligent Assistance Tools (Examples/Stubs) ---

server.addTool({
name: 'fixListFormatting',
annotations: { readOnlyHint: false },
description: 'EXPERIMENTAL: Attempts to detect paragraphs that look like lists (e.g., starting with -, *, 1.) and convert them to proper Google Docs bulleted or numbered lists. Best used on specific sections.',
parameters: DocumentIdParameter.extend({
// Optional range to limit the scope, otherwise scans whole doc (potentially slow/risky)
range: OptionalRangeParameters.optional().describe("Optional: Limit the fixing process to a specific range.")
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.warn(`Executing EXPERIMENTAL fixListFormatting for doc ${args.documentId}. Range: ${JSON.stringify(args.range)}`);
try {
await GDocsHelpers.detectAndFormatLists(docs, args.documentId, args.range?.startIndex, args.range?.endIndex);
return `Attempted to fix list formatting. Please review the document for accuracy.`;
} catch (error: any) {
log.error(`Error fixing list formatting in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
if (error instanceof NotImplementedError) throw error; // Expected if helper not implemented
throw new UserError(`Failed to fix list formatting: ${error.message || 'Unknown error'}`);
}
}
});

// === COMMENT TOOLS ===

server.addTool({
  name: 'listComments',
  annotations: { readOnlyHint: true },
  description: 'Lists all comments in a Google Document.',
  parameters: DocumentIdParameter,
  execute: async (args, { log, session }) => {
    log.info(`Listing comments for document ${args.documentId}`);
    const docsClient = await getDocsClient(session);
    const driveClient = await getDriveClient(session);

    try {
      // First get the document to have context
      const doc = await docsClient.documents.get({ documentId: args.documentId });

      // Use Drive API v3 with proper fields to get quoted content
      const drive = await getDriveClient(session);
      const response = await drive.comments.list({
        fileId: args.documentId,
        fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved)',
        pageSize: 100
      });

      const comments = response.data.comments || [];

      if (comments.length === 0) {
        return 'No comments found in this document.';
      }

      // Format comments for display
      const formattedComments = comments.map((comment: any, index: number) => {
        const replies = comment.replies?.length || 0;
        const status = comment.resolved ? ' [RESOLVED]' : '';
        const author = comment.author?.displayName || 'Unknown';
        const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : 'Unknown date';

        // Get the actual quoted text content
        const quotedText = comment.quotedFileContent?.value || 'No quoted text';
        const anchor = quotedText !== 'No quoted text' ? ` (anchored to: "${quotedText.substring(0, 100)}${quotedText.length > 100 ? '...' : ''}")` : '';

        let result = `\n${index + 1}. **${author}** (${date})${status}${anchor}\n   ${comment.content}`;

        if (replies > 0) {
          result += `\n   └─ ${replies} ${replies === 1 ? 'reply' : 'replies'}`;
        }

        result += `\n   Comment ID: ${comment.id}`;

        return result;
      }).join('\n');

      return `Found ${comments.length} comment${comments.length === 1 ? '' : 's'}:\n${formattedComments}`;

    } catch (error: any) {
      log.error(`Error listing comments: ${error.message || error}`);
      throw new UserError(`Failed to list comments: ${error.message || 'Unknown error'}`);
    }
  }
});

server.addTool({
  name: 'getComment',
  annotations: { readOnlyHint: true },
  description: 'Gets a specific comment with its full thread of replies.',
  parameters: DocumentIdParameter.extend({
    commentId: z.string().describe('The ID of the comment to retrieve')
  }),
  execute: async (args, { log, session }) => {
    log.info(`Getting comment ${args.commentId} from document ${args.documentId}`);

    try {
      const drive = await getDriveClient(session);
      const response = await drive.comments.get({
        fileId: args.documentId,
        commentId: args.commentId,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)'
      });

      const comment = response.data;
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.createdTime ? new Date(comment.createdTime).toLocaleDateString() : 'Unknown date';
      const status = comment.resolved ? ' [RESOLVED]' : '';
      const quotedText = comment.quotedFileContent?.value || 'No quoted text';
      const anchor = quotedText !== 'No quoted text' ? `\nAnchored to: "${quotedText}"` : '';

      let result = `**${author}** (${date})${status}${anchor}\n${comment.content}`;

      // Add replies if any
      if (comment.replies && comment.replies.length > 0) {
        result += '\n\n**Replies:**';
        comment.replies.forEach((reply: any, index: number) => {
          const replyAuthor = reply.author?.displayName || 'Unknown';
          const replyDate = reply.createdTime ? new Date(reply.createdTime).toLocaleDateString() : 'Unknown date';
          result += `\n${index + 1}. **${replyAuthor}** (${replyDate})\n   ${reply.content}`;
        });
      }

      return result;

    } catch (error: any) {
      log.error(`Error getting comment: ${error.message || error}`);
      throw new UserError(`Failed to get comment: ${error.message || 'Unknown error'}`);
    }
  }
});

server.addTool({
  name: 'addComment',
  annotations: { readOnlyHint: false },
  description: 'Adds a comment to a Google Document with quoted text context. NOTE: Due to Google Drive API limitations, comments cannot be anchored to specific text positions in Google Docs. The comment will appear in the Comments panel with the quoted text displayed, but won\'t highlight text in the document body.',
  parameters: addCommentSchema,
  execute: async (args, { log, session }) => {
    log.info(`Adding comment to range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}`);
    try {
      const docsClient = await getDocsClient(session);
      const drive = await getDriveClient(session);
      const comment = await performAddComment(docsClient, drive, args);
      return `Comment added successfully. Comment ID: ${comment.id}`;
    } catch (error: any) {
      log.error(`Error adding comment: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to add comment: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'replyToComment',
  annotations: { readOnlyHint: false },
  description: 'Adds a reply to an existing comment.',
  parameters: replyToCommentSchema,
  execute: async (args, { log, session }) => {
    log.info(`Adding reply to comment ${args.commentId} in doc ${args.documentId}`);
    try {
      const drive = await getDriveClient(session);
      const reply = await performReplyToComment(drive, args);
      return `Reply added successfully. Reply ID: ${reply.id}`;
    } catch (error: any) {
      log.error(`Error adding reply: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to add reply: ${error.message || 'Unknown error'}`);
    }
  },
});

server.addTool({
  name: 'resolveComment',
  annotations: { readOnlyHint: false },
  description: 'Marks a comment as resolved. NOTE: Due to Google API limitations, the Drive API does not support resolving comments on Google Docs files. This operation will attempt to update the comment but the resolved status may not persist in the UI. Comments can be resolved manually in the Google Docs interface.',
  parameters: resolveCommentSchema,
  execute: async (args, { log, session }) => {
    log.info(`Resolving comment ${args.commentId} in doc ${args.documentId}`);
    try {
      const drive = await getDriveClient(session);
      const { resolved } = await performResolveComment(drive, args);
      if (resolved) {
        return `Comment ${args.commentId} has been marked as resolved.`;
      }
      return `Attempted to resolve comment ${args.commentId}, but the resolved status may not persist in the Google Docs UI due to API limitations. The comment can be resolved manually in the Google Docs interface.`;
    } catch (error: any) {
      log.error(`Error resolving comment: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      const errorDetails = error.response?.data?.error?.message || error.message || 'Unknown error';
      const errorCode = error.response?.data?.error?.code;
      throw new UserError(`Failed to resolve comment: ${errorDetails}${errorCode ? ` (Code: ${errorCode})` : ''}`);
    }
  },
});

server.addTool({
  name: 'deleteComment',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Deletes a comment from the document.',
  parameters: deleteCommentSchema,
  execute: async (args, { log, session }) => {
    log.info(`Deleting comment ${args.commentId} from doc ${args.documentId}`);
    try {
      const drive = await getDriveClient(session);
      await performDeleteComment(drive, args);
      return `Comment ${args.commentId} has been deleted.`;
    } catch (error: any) {
      log.error(`Error deleting comment: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to delete comment: ${error.message || 'Unknown error'}`);
    }
  },
});

// --- Add Stubs for other advanced features ---
// (findElement, getDocumentMetadata, replaceText, list management, image handling, section breaks, footnotes, etc.)
// Example Stub:
server.addTool({
name: 'findElement',
annotations: { readOnlyHint: true },
description: 'NOT IMPLEMENTED — always throws. For text search use findAndReplace or formatMatchingText; for structure exploration use inspectDocStructure.',
parameters: DocumentIdParameter.extend({
// Define complex query parameters...
textQuery: z.string().optional(),
elementType: z.enum(['paragraph', 'table', 'list', 'image']).optional(),
// styleQuery...
}),
execute: async (args, { log, session }) => {
log.warn("findElement tool called but is not implemented.");
throw new NotImplementedError("Finding elements by complex criteria is not yet implemented.");
}
});

// --- Preserve the existing formatMatchingText tool for backward compatibility ---
server.addTool({
  name: 'formatMatchingText',
  annotations: { readOnlyHint: false },
  description: 'Finds specific text within a Google Document and applies character formatting (bold, italics, color, etc.) to the specified instance.',
  parameters: formatMatchingTextSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Using formatMatchingText (legacy) for doc ${args.documentId}, target: "${args.textToFind}" (instance ${args.matchInstance})`);
    try {
      const { fields } = await performFormatMatchingText(docs, args);
      if (!fields) return "No valid text styling options were provided.";
      return `Successfully applied formatting to instance ${args.matchInstance} of "${args.textToFind}".`;
    } catch (error: any) {
      log.error(`Error in formatMatchingText for doc ${args.documentId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to format text: ${error.message || 'Unknown error'}`);
    }
  },
});

// === FIND AND REPLACE TOOL ===

server.addTool({
  name: 'findAndReplace',
  annotations: { readOnlyHint: false },
  description: 'Finds all occurrences of a text string in a Google Doc and replaces them. Returns the number of replacements made.',
  parameters: findAndReplaceSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Find and replace in doc ${args.documentId}: "${args.findText}" → "${args.replaceText}" (matchCase: ${args.matchCase})`);
    const { occurrencesChanged } = await performFindAndReplace(docs, args);
    return `Replaced ${occurrencesChanged} occurrence(s) of "${args.findText}" with "${args.replaceText}".`;
  },
});

// === INSPECT DOCUMENT STRUCTURE TOOL ===

/** Elements listed by inspectDocStructure(detailed) before truncation kicks in. */
const DEFAULT_MAX_STRUCTURE_ELEMENTS = 500;

server.addTool({
name: 'inspectDocStructure',
annotations: { readOnlyHint: true },
description: 'Analyzes and returns the structure of a Google Doc: paragraph/table/section counts, headers/footers presence, tab hierarchy. Use detailed mode for element-by-element listing.',
parameters: z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  detailed: z.boolean().optional().default(false).describe('If true, returns element-by-element listing with type, position, and text previews.'),
  tabId: z.string().optional().describe('Optional tab ID to inspect (defaults to first tab).'),
  maxElements: z.number().int().min(0).optional().describe(`Maximum elements to list in detailed mode (default ${DEFAULT_MAX_STRUCTURE_ELEMENTS}). Omitted elements are reported, never silently dropped.`),
}),
execute: async (args, { log, session }) => {
  const docs = await getDocsClient(session);
  log.info(`Inspecting structure of doc ${args.documentId} (detailed: ${args.detailed})`);

  const res = await docs.documents.get({
    documentId: args.documentId,
    includeTabsContent: true,
  });

  const doc = res.data;
  if (!doc) {
    throw new UserError(`Document not found (ID: ${args.documentId}).`);
  }

  const structure: any = GDocsHelpers.parseDocStructure(doc, args.detailed ?? false, args.tabId);

  // Detailed mode had no bound at all: one element entry per paragraph across a
  // whole document, in a single response. Cap it, and say what was left out —
  // a silently short listing reads as "that is the whole document".
  const limit = args.maxElements ?? DEFAULT_MAX_STRUCTURE_ELEMENTS;
  if (Array.isArray(structure?.elements) && structure.elements.length > limit) {
    const total = structure.elements.length;
    structure.elements = structure.elements.slice(0, limit);
    structure.elementsTruncated = {
      shown: limit,
      total,
      note: `${total - limit} further element(s) were omitted. Raise maxElements, or inspect a single tab with tabId, to see them.`,
    };
  }
  // Titles (document and tab) reach the output only through here, so this is
  // the one place they can be sanitised.
  return assertTransportSafe(stringifySafe(structure, 2), {
    documentId: args.documentId,
    what: 'structure',
  });
}
});

// === IMPORT DOCX TOOL ===

server.addTool({
  name: 'importDocx',
  annotations: { readOnlyHint: false },
  description: 'Converts a .docx file already in Google Drive into a Google Doc. Drive auto-converts the format. Returns the new Google Doc ID and link.',
  parameters: importDocxSchema,
  execute: async (args, { log, session }) => {
    const drive = await getDriveClient(session);
    log.info(`Importing DOCX ${args.fileId} as Google Doc`);
    const newDoc = await performImportDocx(drive, args);
    return `DOCX imported successfully as Google Doc:\n  Document ID: ${newDoc.id}\n  Title: ${newDoc.name}\n  Link: ${newDoc.webViewLink}`;
  },
});

// === BATCH UPDATE DOC TOOL ===

server.addTool({
  name: 'batchUpdateDoc',
  annotations: { readOnlyHint: false },
  description: 'Executes multiple document operations in a single batch. Supports: insert_text, delete_text, replace_text, format_text, update_paragraph_style, insert_table, insert_page_break, find_replace, create_bullet_list. Index-based operations are automatically sorted in descending order to prevent index shifting.',
  parameters: batchUpdateDocSchema,
  execute: async (args, { log, session }) => {
    const docs = await getDocsClient(session);
    log.info(`Batch update on doc ${args.documentId}: ${args.operations.length} operation(s)`);
    const { executed, typeCounts } = await performBatchUpdateDoc(docs, args);
    if (executed === 0) return 'No valid operations to execute.';
    const summary = Object.entries(typeCounts).map(([type, count]) => `${count}x ${type}`).join(', ');
    return `Batch update completed: ${args.operations.length} operation(s) executed (${summary}).`;
  },
});
server.addTool({
  name: 'importToGoogleDoc',
  annotations: { readOnlyHint: false },
  description: 'Import content (text, HTML, or markdown) into a new Google Doc. Google Drive auto-converts the content to Google Docs format.',
  parameters: importToGoogleDocSchema,
  execute: async (args, { log, session }) => {
    const drive = await getDriveClient(session);
    log.info(`Importing content as Google Doc: "${args.title}" (mimeType: ${args.mimeType})`);
    try {
      const doc = await performImportToGoogleDoc(drive, args);
      return `Google Doc created successfully:\n  Title: ${doc.name}\n  Document ID: ${doc.id}\n  Link: ${doc.webViewLink}`;
    } catch (error: any) {
      log.error(`Error importing to Google Doc: ${error.message || error}`);
      handleDriveError(error, 'import content to', args.parentFolderId || args.title);
    }
  },
});

// --- Environment variables for remote deployment ---
const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TRANSPORT = process.env.TRANSPORT || "stdio"; // "stdio" or "httpStream"
const DOCS_MCP_PORT = parseInt(process.env.INTERNAL_MCP_PORT || "3001", 10);
const CALENDAR_MCP_PORT = parseInt(process.env.CALENDAR_MCP_PORT || "3002", 10);
const SHEETS_MCP_PORT = parseInt(process.env.SHEETS_MCP_PORT || "3003", 10);
const GMAIL_MCP_PORT = parseInt(process.env.GMAIL_MCP_PORT || "3004", 10);
const SLIDES_MCP_PORT = parseInt(process.env.SLIDES_MCP_PORT || "3005", 10);
const DRIVE_MCP_PORT = parseInt(process.env.DRIVE_MCP_PORT || "3006", 10);
const CLICKUP_MCP_PORT = parseInt(process.env.CLICKUP_MCP_PORT || "3007", 10);
const SLACK_BOT_MCP_PORT = parseInt(process.env.SLACK_BOT_MCP_PORT || "3008", 10);
const SLACK_USER_MCP_PORT = parseInt(process.env.SLACK_USER_MCP_PORT || "3009", 10);

// Multi-service deployment mode
// - undefined or "all": Run everything (website + MCPs) - default single-service mode
// - "web": Run only website (Express) without internal MCP servers
// - "mcp": Run only the MCP server specified by MCP_SLUG (standalone, no proxy)
const MCP_MODE = process.env.MCP_MODE || "all";

// --- Server Startup ---
async function startServer() {
  try {
    console.error("Starting Google Docs MCP Server...");
    console.error(`Mode: ${TRANSPORT}, MCP_MODE: ${MCP_MODE}, Port: ${PORT}`);

    if (TRANSPORT === "httpStream" || TRANSPORT === "http" || TRANSPORT === "remote") {
      // Multi-user HTTP mode

      // Fail fast if the image host isn't configured — a bad/missing value would
      // otherwise get permanently embedded in ClickUp docs on first upload. Only
      // services that actually upload images need this: the all-in-one service
      // and the ClickUp MCP. The website and non-image MCP services start without
      // it (an errant upload there still fails safely via store()'s own check).
      const hostsImages = (MCP_MODE !== "web" && MCP_MODE !== "mcp") || (MCP_MODE === "mcp" && MCP_SLUG === "clickup");
      if (hostsImages) {
        assertImagePublicBaseUrlConfigured();
      }

      await initDatabase();
      await loadUsers();

      // Only seed catalogs in web and all modes - MCP services shouldn't modify the catalog
      if (MCP_MODE !== "mcp") {
        await seedDefaultCatalogs();
      }

      if (MCP_MODE === "web") {
        // Website-only mode: Run Express without internal MCP servers
        // Used in multi-service deployment where MCPs run as separate services
        const { createWebOnlyApp } = await import('../website/webServer.js');
        const expressApp = createWebOnlyApp();

        expressApp.listen(PORT, HOST, () => {
          console.error(`Website running on port ${PORT}!`);
          console.error(`   Health Check:   http://${HOST}:${PORT}/health`);
          console.error(`   Registration:   http://${HOST}:${PORT}/`);
          console.error(`   Dashboard:      http://${HOST}:${PORT}/dashboard`);
          console.error(`   OAuth Callback: http://${HOST}:${PORT}/auth/callback`);
        });

      } else if (MCP_MODE === "mcp") {
        // MCP-only mode: Run MCP server with OAuth routes for Claude.ai connector support
        // Used in multi-service deployment where this service is one specific MCP
        // NOTE: We skip seedDefaultCatalogs() here - the website service manages the catalog
        const INTERNAL_MCP_PORT = 3001;

        // Pick the right MCP server based on MCP_SLUG. A lookup table rather
        // than a ternary chain: adding a connector is one line, and an
        // unmatched slug falls through to google-docs exactly as before.
        const MCP_SERVERS_BY_SLUG: Record<string, typeof server> = {
          "google-calendar": calendarServer,
          "google-sheets":   sheetsServer,
          "google-gmail":    gmailServer,
          "google-slides":   slidesServer,
          "google-drive":    driveServer,
          "clickup":         clickUpServer,
          "slack-bot":       slackBotServer,
          "slack":           slackUserServer,
          "outline":         outlineServer,
          "peopleforce":     peopleForceServer,
          "peopleforce-v4":  peopleForceV4Server,
          "hubspot":         hubspotServer,
          "redmine":         redmineServer,
          "browserbase":     browserbaseServer,
        };
        const mcpToStart = MCP_SERVERS_BY_SLUG[MCP_SLUG] ?? server; // default: google-docs

        mcpToStart.start({
          transportType: "httpStream",
          httpStream: {
            port: INTERNAL_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        const { createMcpOnlyApp } = await import('../website/webServer.js');
        const expressApp = createMcpOnlyApp(INTERNAL_MCP_PORT);
        const httpServer = expressApp.listen(PORT, HOST, () => {
          console.error(`${MCP_SLUG} MCP running on port ${PORT}!`);
          console.error(`   MCP Endpoint:   http://${HOST}:${PORT}/mcp`);
          console.error(`   OAuth Metadata: http://${HOST}:${PORT}/.well-known/oauth-authorization-server`);
        });
        // Disable server-level timeouts for long-lived SSE streams
        httpServer.timeout = 0;
        httpServer.keepAliveTimeout = 120_000;

      } else {
        // Default "all" mode: Single service with Express + internal MCP servers
        // Start Google Docs MCP on internal port
        server.start({
          transportType: "httpStream",
          httpStream: {
            port: DOCS_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Google Calendar MCP on separate internal port
        calendarServer.start({
          transportType: "httpStream",
          httpStream: {
            port: CALENDAR_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Google Sheets MCP on separate internal port
        sheetsServer.start({
          transportType: "httpStream",
          httpStream: {
            port: SHEETS_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Google Gmail MCP on separate internal port
        gmailServer.start({
          transportType: "httpStream",
          httpStream: {
            port: GMAIL_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Google Slides MCP on separate internal port
        slidesServer.start({
          transportType: "httpStream",
          httpStream: {
            port: SLIDES_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Google Drive MCP on separate internal port
        driveServer.start({
          transportType: "httpStream",
          httpStream: {
            port: DRIVE_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start ClickUp MCP on separate internal port
        clickUpServer.start({
          transportType: "httpStream",
          httpStream: {
            port: CLICKUP_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Slack Bot MCP on separate internal port
        slackBotServer.start({
          transportType: "httpStream",
          httpStream: {
            port: SLACK_BOT_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Start Slack User MCP on separate internal port
        slackUserServer.start({
          transportType: "httpStream",
          httpStream: {
            port: SLACK_USER_MCP_PORT,
            host: "127.0.0.1",
          },
        });

        // Create Express app with proxy routes and registration/OAuth pages
        const expressApp = createWebApp(DOCS_MCP_PORT, CALENDAR_MCP_PORT, SHEETS_MCP_PORT, GMAIL_MCP_PORT, SLIDES_MCP_PORT, DRIVE_MCP_PORT, CLICKUP_MCP_PORT, SLACK_BOT_MCP_PORT, SLACK_USER_MCP_PORT);

        // Start Express on the public port — single port for all traffic
        const httpServer = expressApp.listen(PORT, HOST, () => {
          console.error(`Server running on port ${PORT}!`);
          console.error(`   Docs MCP:       http://${HOST}:${PORT}/mcp`);
          console.error(`   Calendar MCP:   http://${HOST}:${PORT}/calendar`);
          console.error(`   Gmail MCP:      http://${HOST}:${PORT}/gmail`);
          console.error(`   Slides MCP:     http://${HOST}:${PORT}/slides`);
          console.error(`   Drive MCP:      http://${HOST}:${PORT}/drive`);
          console.error(`   ClickUp MCP:    http://${HOST}:${PORT}/clickup`);
          console.error(`   Slack Bot MCP:  http://${HOST}:${PORT}/slack-bot`);
          console.error(`   Slack MCP:      http://${HOST}:${PORT}/slack`);
          console.error(`   Health Check:   http://${HOST}:${PORT}/health`);
          console.error(`   Registration:   http://${HOST}:${PORT}/`);
          console.error(`   OAuth Callback: http://${HOST}:${PORT}/auth/callback`);
        });
        // Disable server-level timeouts for long-lived SSE streams
        httpServer.timeout = 0;
        httpServer.keepAliveTimeout = 120_000;
      }

    } else {
      // Default: stdio mode for local Claude Desktop (single-user, backward compatible)
      await initializeGoogleClient();
      server.start({
        transportType: "stdio" as const,
      });
      console.error(`STDIO server running. Awaiting client connection...`);
    }

  } catch(startError: any) {
    console.error("FATAL: Server failed to start:", startError.message || startError);
    process.exit(1);
  }
}

/**
 * Boot unless we are inside the test runner.
 *
 * This file is the application entry point (Dockerfile CMD and railway.json both
 * run `node dist/google-docs/server.js`), and it called startServer() at import
 * time — so importing it from a test started a real server, bound ports and
 * reached for Google and Postgres. That is why nothing imported it, and why its
 * ~770 executable lines, including every tool body, sat at 0% coverage.
 *
 * Phrased as "start unless under test", NOT as "start if this is the entry
 * point", because the two fail in opposite directions. An entry-point check that
 * guesses wrong about argv silently stops production from booting; this one, if
 * it ever guessed wrong, would only boot a server inside a test — loud, local,
 * and harmless. `NODE_TEST_CONTEXT` is set by `node --test` itself.
 */
const UNDER_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined;

if (!UNDER_TEST_RUNNER) {
  startServer();
}

process.on('SIGTERM', async () => {
  console.error('SIGTERM received, shutting down...');
  await closeDatabase();
  process.exit(0);
});
