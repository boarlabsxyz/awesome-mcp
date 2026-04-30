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
import { seedDefaultCatalogs } from '../mcpCatalogStore.js';
import { calendarServer } from '../google-calendar/server.js';
import { sheetsServer } from '../google-sheets/server.js';
import { gmailServer } from '../google-gmail/server.js';
import { slidesServer } from '../google-slides/server.js';
import { driveServer } from '../google-drive/server.js';
import { clickUpServer } from '../clickup/server.js';
import { slackBotServer } from '../slack/server.js';
import { slackUserServer } from '../slack-user/server.js';
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
  description: 'Gets the most recently modified Google Documents from My Drive and shared drives.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of recent documents to return.'),
    daysBack: z.number().int().min(1).max(365).optional().default(30).describe('Only show documents modified within this many days.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleGetRecentGoogleDocs(await getDriveClient(session), args, log),
});

server.addTool({
  name: 'exportDocToPdf',
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

        const fields = args.format === 'json' || args.format === 'markdown'
            ? '*' // Get everything for structure analysis
            : 'body(content(paragraph(elements(textRun(content)))))'; // Just text content

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
            const jsonContent = JSON.stringify(contentSource, null, 2);
            // Apply length limit to JSON if specified
            if (args.maxLength && jsonContent.length > args.maxLength) {
                return jsonContent.substring(0, args.maxLength) + `\n... [JSON truncated: ${jsonContent.length} total chars]`;
            }
            return jsonContent;
        }

        if (args.format === 'markdown') {
            const markdownContent = convertDocsJsonToMarkdown(contentSource);
            const totalLength = markdownContent.length;
            log.info(`Generated markdown: ${totalLength} characters`);

            // Apply length limit to markdown if specified
            if (args.maxLength && totalLength > args.maxLength) {
                const truncatedContent = markdownContent.substring(0, args.maxLength);
                return `${truncatedContent}\n\n... [Markdown truncated to ${args.maxLength} chars of ${totalLength} total. Use maxLength parameter to adjust limit or remove it to get full content.]`;
            }

            return markdownContent;
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

        const totalLength = textContent.length;
        log.info(`Document contains ${totalLength} characters across ${elementCount} elements`);
        log.info(`maxLength parameter: ${args.maxLength || 'not specified'}`);

        // Apply length limit only if specified
        if (args.maxLength && totalLength > args.maxLength) {
            const truncatedContent = textContent.substring(0, args.maxLength);
            log.info(`Truncating content from ${totalLength} to ${args.maxLength} characters`);
            return `Content (truncated to ${args.maxLength} chars of ${totalLength} total):\n---\n${truncatedContent}\n\n... [Document continues for ${totalLength - args.maxLength} more characters. Use maxLength parameter to adjust limit or remove it to get full content.]`;
        }

        // Return full content
        const fullResponse = `Content (${totalLength} characters):\n---\n${textContent}`;
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
description: 'Appends text to the very end of a specific Google Document or tab.',
parameters: DocumentIdParameter.extend({
textToAppend: z.string().min(1).describe('The text to add to the end.'),
addNewlineIfNeeded: z.boolean().optional().default(true).describe("Automatically add a newline before the appended text if the doc doesn't end with one."),
tabId: z.string().optional().describe('The ID of the specific tab to append to. If not specified, appends to the first tab (or legacy document.body for documents without tabs).')
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Appending to Google Doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);

    try {
        // Determine if we need tabs content
        const needsTabsContent = !!args.tabId;

        // Get the current end index
        const docInfo = await docs.documents.get({
            documentId: args.documentId,
            includeTabsContent: needsTabsContent,
            fields: needsTabsContent ? 'tabs' : 'body(content(endIndex)),documentStyle(pageSize)'
        });

        let endIndex = 1;
        let bodyContent: any;

        // If tabId is specified, find the specific tab
        if (args.tabId) {
            const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
            if (!targetTab) {
                throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
            }
            if (!targetTab.documentTab) {
                throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
            }
            bodyContent = targetTab.documentTab.body?.content;
        } else {
            bodyContent = docInfo.data.body?.content;
        }

        if (bodyContent) {
            const lastElement = bodyContent[bodyContent.length - 1];
            if (lastElement?.endIndex) {
                endIndex = lastElement.endIndex - 1; // Insert *before* the final newline of the doc typically
            }
        }

        // Simpler approach: Always assume insertion is needed unless explicitly told not to add newline
        const textToInsert = (args.addNewlineIfNeeded && endIndex > 1 ? '\n' : '') + args.textToAppend;

        if (!textToInsert) return "Nothing to append.";

        const location: any = { index: endIndex };
        if (args.tabId) {
            location.tabId = args.tabId;
        }

        const request: docs_v1.Schema$Request = { insertText: { location, text: textToInsert } };
        await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);

        log.info(`Successfully appended to doc: ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
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
description: 'Inserts text at a specific index within the document body or a specific tab.',
parameters: DocumentIdParameter.extend({
textToInsert: z.string().min(1).describe('The text to insert.'),
index: z.number().int().min(1).describe('The index (1-based) where the text should be inserted.'),
tabId: z.string().optional().describe('The ID of the specific tab to insert into. If not specified, inserts into the first tab (or legacy document.body for documents without tabs).')
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Inserting text in doc ${args.documentId} at index ${args.index}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
try {
    if (args.tabId) {
        // For tab-specific inserts, we need to verify the tab exists first
        const docInfo = await docs.documents.get({
            documentId: args.documentId,
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)'
        });
        const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
        if (!targetTab) {
            throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
        }
        if (!targetTab.documentTab) {
            throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
        }

        // Insert with tabId
        const location: any = { index: args.index, tabId: args.tabId };
        const request: docs_v1.Schema$Request = { insertText: { location, text: args.textToInsert } };
        await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
    } else {
        // Use existing helper for backward compatibility
        await GDocsHelpers.insertText(docs, args.documentId, args.textToInsert, args.index);
    }
    return `Successfully inserted text at index ${args.index}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
} catch (error: any) {
log.error(`Error inserting text in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
throw new UserError(`Failed to insert text: ${error.message || 'Unknown error'}`);
}
}
});

server.addTool({
name: 'deleteRange',
description: 'Deletes content within a specified range (start index inclusive, end index exclusive) from the document or a specific tab.',
parameters: DocumentIdParameter.extend({
  startIndex: z.number().int().min(1).describe('The starting index of the text range (inclusive, starts from 1).'),
  endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
  tabId: z.string().optional().describe('The ID of the specific tab to delete from. If not specified, deletes from the first tab (or legacy document.body for documents without tabs).')
}).refine(data => data.endIndex > data.startIndex, {
  message: "endIndex must be greater than startIndex",
  path: ["endIndex"],
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Deleting range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}${args.tabId ? ` (tab: ${args.tabId})` : ''}`);
if (args.endIndex <= args.startIndex) {
throw new UserError("End index must be greater than start index for deletion.");
}
try {
    // If tabId is specified, verify the tab exists
    if (args.tabId) {
        const docInfo = await docs.documents.get({
            documentId: args.documentId,
            includeTabsContent: true,
            fields: 'tabs(tabProperties,documentTab)'
        });
        const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
        if (!targetTab) {
            throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
        }
        if (!targetTab.documentTab) {
            throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
        }
    }

    const range: any = { startIndex: args.startIndex, endIndex: args.endIndex };
    if (args.tabId) {
        range.tabId = args.tabId;
    }

    const request: docs_v1.Schema$Request = {
        deleteContentRange: { range }
    };
    await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
    return `Successfully deleted content in range ${args.startIndex}-${args.endIndex}${args.tabId ? ` in tab ${args.tabId}` : ''}.`;
} catch (error: any) {
    log.error(`Error deleting range in doc ${args.documentId}: ${error.message || error}`);
    if (error instanceof UserError) throw error;
    throw new UserError(`Failed to delete range: ${error.message || 'Unknown error'}`);
}
}
});

// --- Advanced Formatting & Styling Tools ---

server.addTool({
name: 'applyTextStyle',
description: 'Applies character-level formatting (bold, color, font, etc.) to a specific range or found text.',
parameters: ApplyTextStyleToolParameters,
execute: async (args: ApplyTextStyleToolArgs, { log, session }) => {
const docs = await getDocsClient(session);
let { startIndex, endIndex } = args.target as any; // Will be updated if target is text

        log.info(`Applying text style in doc ${args.documentId}. Target: ${JSON.stringify(args.target)}, Style: ${JSON.stringify(args.style)}`);

        try {
            // Determine target range
            if ('textToFind' in args.target) {
                const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.target.textToFind, args.target.matchInstance);
                if (!range) {
                    throw new UserError(`Could not find instance ${args.target.matchInstance} of text "${args.target.textToFind}".`);
                }
                startIndex = range.startIndex;
                endIndex = range.endIndex;
                log.info(`Found text "${args.target.textToFind}" (instance ${args.target.matchInstance}) at range ${startIndex}-${endIndex}`);
            }

            if (startIndex === undefined || endIndex === undefined) {
                 throw new UserError("Target range could not be determined.");
            }
             if (endIndex <= startIndex) {
                 throw new UserError("End index must be greater than start index for styling.");
            }

            // Build the request
            const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(startIndex, endIndex, args.style);
            if (!requestInfo) {
                 return "No valid text styling options were provided.";
            }

            await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
            return `Successfully applied text style (${requestInfo.fields.join(', ')}) to range ${startIndex}-${endIndex}.`;

        } catch (error: any) {
            log.error(`Error applying text style in doc ${args.documentId}: ${error.message || error}`);
            if (error instanceof UserError) throw error;
            if (error instanceof NotImplementedError) throw error; // Should not happen here
            throw new UserError(`Failed to apply text style: ${error.message || 'Unknown error'}`);
        }
    }

});

server.addTool({
name: 'applyParagraphStyle',
description: 'Applies paragraph-level formatting (alignment, spacing, named styles like Heading 1) to the paragraph(s) containing specific text, an index, or a range.',
parameters: ApplyParagraphStyleToolParameters,
execute: async (args: ApplyParagraphStyleToolArgs, { log, session }) => {
const docs = await getDocsClient(session);
let startIndex: number | undefined;
let endIndex: number | undefined;

        log.info(`Applying paragraph style to document ${args.documentId}`);
        log.info(`Style options: ${JSON.stringify(args.style)}`);
        log.info(`Target specification: ${JSON.stringify(args.target)}`);

        try {
            // STEP 1: Determine the target paragraph's range based on the targeting method
            if ('textToFind' in args.target) {
                // Find the text first
                log.info(`Finding text "${args.target.textToFind}" (instance ${args.target.matchInstance || 1})`);
                const textRange = await GDocsHelpers.findTextRange(
                    docs,
                    args.documentId,
                    args.target.textToFind,
                    args.target.matchInstance || 1
                );

                if (!textRange) {
                    throw new UserError(`Could not find "${args.target.textToFind}" in the document.`);
                }

                log.info(`Found text at range ${textRange.startIndex}-${textRange.endIndex}, now locating containing paragraph`);

                // Then find the paragraph containing this text
                const paragraphRange = await GDocsHelpers.getParagraphRange(
                    docs,
                    args.documentId,
                    textRange.startIndex
                );

                if (!paragraphRange) {
                    throw new UserError(`Found the text but could not determine the paragraph boundaries.`);
                }

                startIndex = paragraphRange.startIndex;
                endIndex = paragraphRange.endIndex;
                log.info(`Text is contained within paragraph at range ${startIndex}-${endIndex}`);

            } else if ('indexWithinParagraph' in args.target) {
                // Find paragraph containing the specified index
                log.info(`Finding paragraph containing index ${args.target.indexWithinParagraph}`);
                const paragraphRange = await GDocsHelpers.getParagraphRange(
                    docs,
                    args.documentId,
                    args.target.indexWithinParagraph
                );

                if (!paragraphRange) {
                    throw new UserError(`Could not find paragraph containing index ${args.target.indexWithinParagraph}.`);
                }

                startIndex = paragraphRange.startIndex;
                endIndex = paragraphRange.endIndex;
                log.info(`Located paragraph at range ${startIndex}-${endIndex}`);

            } else if ('startIndex' in args.target && 'endIndex' in args.target) {
                // Use directly provided range
                startIndex = args.target.startIndex;
                endIndex = args.target.endIndex;
                log.info(`Using provided paragraph range ${startIndex}-${endIndex}`);
            }

            // Verify that we have a valid range
            if (startIndex === undefined || endIndex === undefined) {
                throw new UserError("Could not determine target paragraph range from the provided information.");
            }

            if (endIndex <= startIndex) {
                throw new UserError(`Invalid paragraph range: end index (${endIndex}) must be greater than start index (${startIndex}).`);
            }

            // STEP 2: Build and apply the paragraph style request
            log.info(`Building paragraph style request for range ${startIndex}-${endIndex}`);
            const requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(startIndex, endIndex, args.style);

            if (!requestInfo) {
                return "No valid paragraph styling options were provided.";
            }

            log.info(`Applying styles: ${requestInfo.fields.join(', ')}`);
            await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);

            return `Successfully applied paragraph styles (${requestInfo.fields.join(', ')}) to the paragraph.`;

        } catch (error: any) {
            // Detailed error logging
            log.error(`Error applying paragraph style in doc ${args.documentId}:`);
            log.error(error.stack || error.message || error);

            if (error instanceof UserError) throw error;
            if (error instanceof NotImplementedError) throw error;

            // Provide a more helpful error message
            throw new UserError(`Failed to apply paragraph style: ${error.message || 'Unknown error'}`);
        }
    }
});

// --- Structure & Content Tools ---

server.addTool({
name: 'insertTable',
description: 'Inserts a new table with the specified dimensions at a given index.',
parameters: DocumentIdParameter.extend({
rows: z.number().int().min(1).describe('Number of rows for the new table.'),
columns: z.number().int().min(1).describe('Number of columns for the new table.'),
index: z.number().int().min(1).describe('The index (1-based) where the table should be inserted.'),
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Inserting ${args.rows}x${args.columns} table in doc ${args.documentId} at index ${args.index}`);
try {
await GDocsHelpers.createTable(docs, args.documentId, args.rows, args.columns, args.index);
// The API response contains info about the created table, but might be too complex to return here.
return `Successfully inserted a ${args.rows}x${args.columns} table at index ${args.index}.`;
} catch (error: any) {
log.error(`Error inserting table in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
throw new UserError(`Failed to insert table: ${error.message || 'Unknown error'}`);
}
}
});

server.addTool({
name: 'editTableCell',
description: 'Edits the content and/or basic style of a specific table cell. Requires knowing table start index.',
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
description: 'Inserts a page break at the specified index.',
parameters: DocumentIdParameter.extend({
index: z.number().int().min(1).describe('The index (1-based) where the page break should be inserted.'),
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Inserting page break in doc ${args.documentId} at index ${args.index}`);
try {
const request: docs_v1.Schema$Request = {
insertPageBreak: {
location: { index: args.index }
}
};
await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
return `Successfully inserted page break at index ${args.index}.`;
} catch (error: any) {
log.error(`Error inserting page break in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
throw new UserError(`Failed to insert page break: ${error.message || 'Unknown error'}`);
}
}
});

// --- Image Insertion Tools ---

server.addTool({
name: 'insertImageFromUrl',
description: 'Inserts an inline image into a Google Document from a publicly accessible URL.',
parameters: DocumentIdParameter.extend({
imageUrl: z.string().url().describe('Publicly accessible URL to the image (must be http:// or https://).'),
index: z.number().int().min(1).describe('The index (1-based) where the image should be inserted.'),
width: z.number().min(1).optional().describe('Optional: Width of the image in points.'),
height: z.number().min(1).optional().describe('Optional: Height of the image in points.'),
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
log.info(`Inserting image from URL ${args.imageUrl} at index ${args.index} in doc ${args.documentId}`);

try {
await GDocsHelpers.insertInlineImage(
docs,
args.documentId,
args.imageUrl,
args.index,
args.width,
args.height
);

let sizeInfo = '';
if (args.width && args.height) {
sizeInfo = ` with size ${args.width}x${args.height}pt`;
}

return `Successfully inserted image from URL at index ${args.index}${sizeInfo}.`;
} catch (error: any) {
log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
throw new UserError(`Failed to insert image: ${error.message || 'Unknown error'}`);
}
}
});

server.addTool({
name: 'insertLocalImage',
description: 'Inserts an image into a Google Document. Provide one of: (1) imageUrl — a public HTTP(S) URL to fetch, (2) driveFileId — ID of an image already in Google Drive, (3) localImagePath — absolute path for local/stdio deployments, or (4) imageBase64 + fileName — base64-encoded content for small images.',
parameters: DocumentIdParameter.extend({
imageUrl: z.string().optional().describe('Public HTTP(S) URL of the image to fetch and insert (preferred for remote deployments).'),
driveFileId: z.string().optional().describe('Google Drive file ID of an existing image. The image will be made publicly readable and inserted.'),
localImagePath: z.string().optional().describe('Absolute path to a local image file (for local/stdio deployments only).'),
imageBase64: z.string().optional().describe('Base64-encoded image content. Only for small images; prefer imageUrl for large files.'),
fileName: z.string().optional().describe('File name with extension for MIME type detection (e.g. "photo.jpg"). Required when using imageBase64.'),
index: z.number().int().min(1).describe('The index (1-based) where the image should be inserted in the document.'),
width: z.number().min(1).optional().describe('Optional: Width of the image in points.'),
height: z.number().min(1).optional().describe('Optional: Height of the image in points.'),
uploadToSameFolder: z.boolean().optional().default(true).describe('If true, uploads the image to the same folder as the document. If false, uploads to Drive root.'),
}),
execute: async (args, { log, session }) => {
const docs = await getDocsClient(session);
const drive = await getDriveClient(session);

// Validate inputs
const strategy = GDocsHelpers.validateImageSource(args);

const imageSource = args.imageUrl || args.driveFileId || args.localImagePath || args.fileName || 'base64 image';
log.info(`Inserting image ${imageSource} at index ${args.index} in doc ${args.documentId}`);

try {
let resolvedImageUrl: string;

if (strategy === 'driveFile') {
// Image already in Drive — just make it public and get URL
log.info(`Using existing Drive file: ${args.driveFileId}`);
resolvedImageUrl = await GDocsHelpers.getPublicUrlForDriveFile(drive, args.driveFileId!);
} else {
// Need to upload to Drive first (from URL, local path, or base64)
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
let imageBuffer: Buffer | undefined;
if (args.imageBase64) {
const b64 = args.imageBase64;
if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
throw new UserError('imageBase64 contains invalid characters. Provide a valid base64-encoded string.');
}
const decodedSize = Math.floor((b64.length * 3) / 4)
  - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
if (decodedSize > MAX_IMAGE_BYTES) {
throw new UserError(`imageBase64 decodes to ${decodedSize} bytes, exceeding the ${MAX_IMAGE_BYTES} byte limit.`);
}
imageBuffer = Buffer.from(b64, 'base64');
}

// Get the document's parent folder if requested
let parentFolderId: string | undefined;
if (args.uploadToSameFolder) {
try {
const docInfo = await drive.files.get({
fileId: args.documentId,
fields: 'parents'
});
if (docInfo.data.parents && docInfo.data.parents.length > 0) {
parentFolderId = docInfo.data.parents[0];
log.info(`Will upload image to document's parent folder: ${parentFolderId}`);
}
} catch (folderError) {
log.warn(`Could not determine document's parent folder, using Drive root: ${folderError}`);
}
}

log.info(`Uploading image to Drive...`);
resolvedImageUrl = await GDocsHelpers.uploadImageToDrive(
drive,
args.localImagePath,
parentFolderId,
imageBuffer,
args.fileName,
args.imageUrl
);
}
log.info(`Image URL resolved: ${resolvedImageUrl}`);

// Insert the image into the document
await GDocsHelpers.insertInlineImage(
docs,
args.documentId,
resolvedImageUrl,
args.index,
args.width,
args.height
);

let sizeInfo = '';
if (args.width && args.height) {
sizeInfo = ` with size ${args.width}x${args.height}pt`;
}

return `Successfully inserted image at index ${args.index}${sizeInfo}.\nImage URL: ${resolvedImageUrl}`;
} catch (error: any) {
log.error(`Error inserting image in doc ${args.documentId}: ${error.message || error}`);
if (error instanceof UserError) throw error;
throw new UserError(`Failed to insert image: ${error.message || 'Unknown error'}`);
}
}
});

// --- Intelligent Assistance Tools (Examples/Stubs) ---

server.addTool({
name: 'fixListFormatting',
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
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });
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
  description: 'Gets a specific comment with its full thread of replies.',
  parameters: DocumentIdParameter.extend({
    commentId: z.string().describe('The ID of the comment to retrieve')
  }),
  execute: async (args, { log, session }) => {
    log.info(`Getting comment ${args.commentId} from document ${args.documentId}`);

    try {
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });
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
  description: 'Adds a comment to a Google Document with quoted text context. NOTE: Due to Google Drive API limitations, comments cannot be anchored to specific text positions in Google Docs. The comment will appear in the Comments panel with the quoted text displayed, but won\'t highlight text in the document body.',
  parameters: DocumentIdParameter.extend({
    startIndex: z.number().int().min(1).describe('The starting index of the text range (inclusive, starts from 1).'),
    endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
    commentText: z.string().min(1).describe('The content of the comment.'),
  }).refine(data => data.endIndex > data.startIndex, {
    message: 'endIndex must be greater than startIndex',
    path: ['endIndex'],
  }),
  execute: async (args, { log, session }) => {
    log.info(`Adding comment to range ${args.startIndex}-${args.endIndex} in doc ${args.documentId}`);

    try {
      // First, get the text content that will be quoted
      const docsClient = await getDocsClient(session);
      const doc = await docsClient.documents.get({ documentId: args.documentId });

      // Extract the quoted text from the document
      let quotedText = '';
      const content = doc.data.body?.content || [];

      for (const element of content) {
        if (element.paragraph) {
          const elements = element.paragraph.elements || [];
          for (const textElement of elements) {
            if (textElement.textRun) {
              const elementStart = textElement.startIndex || 0;
              const elementEnd = textElement.endIndex || 0;

              // Check if this element overlaps with our range
              if (elementEnd > args.startIndex && elementStart < args.endIndex) {
                const text = textElement.textRun.content || '';
                const startOffset = Math.max(0, args.startIndex - elementStart);
                const endOffset = Math.min(text.length, args.endIndex - elementStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }
      }

      // Use Drive API v3 for comments
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });

      const response = await drive.comments.create({
        fileId: args.documentId,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved',
        requestBody: {
          content: args.commentText,
          quotedFileContent: {
            value: quotedText,
            mimeType: 'text/html'
          }
          // anchor removed - Google Drive API ignores it for Google Docs and causes "original content deleted"
        }
      });

      return `Comment added successfully. Comment ID: ${response.data.id}`;

    } catch (error: any) {
      log.error(`Error adding comment: ${error.message || error}`);
      throw new UserError(`Failed to add comment: ${error.message || 'Unknown error'}`);
    }
  }
});

server.addTool({
  name: 'replyToComment',
  description: 'Adds a reply to an existing comment.',
  parameters: DocumentIdParameter.extend({
    commentId: z.string().describe('The ID of the comment to reply to'),
    replyText: z.string().min(1).describe('The content of the reply')
  }),
  execute: async (args, { log, session }) => {
    log.info(`Adding reply to comment ${args.commentId} in doc ${args.documentId}`);

    try {
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });

      const response = await drive.replies.create({
        fileId: args.documentId,
        commentId: args.commentId,
        fields: 'id,content,author,createdTime',
        requestBody: {
          content: args.replyText
        }
      });

      return `Reply added successfully. Reply ID: ${response.data.id}`;

    } catch (error: any) {
      log.error(`Error adding reply: ${error.message || error}`);
      throw new UserError(`Failed to add reply: ${error.message || 'Unknown error'}`);
    }
  }
});

server.addTool({
  name: 'resolveComment',
  description: 'Marks a comment as resolved. NOTE: Due to Google API limitations, the Drive API does not support resolving comments on Google Docs files. This operation will attempt to update the comment but the resolved status may not persist in the UI. Comments can be resolved manually in the Google Docs interface.',
  parameters: DocumentIdParameter.extend({
    commentId: z.string().describe('The ID of the comment to resolve')
  }),
  execute: async (args, { log, session }) => {
    log.info(`Resolving comment ${args.commentId} in doc ${args.documentId}`);

    try {
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });

      // First, get the current comment content (required by the API)
      const currentComment = await drive.comments.get({
        fileId: args.documentId,
        commentId: args.commentId,
        fields: 'content'
      });

      // Update with both content and resolved status
      await drive.comments.update({
        fileId: args.documentId,
        commentId: args.commentId,
        fields: 'id,resolved',
        requestBody: {
          content: currentComment.data.content,
          resolved: true
        }
      });

      // Verify the resolved status was set
      const verifyComment = await drive.comments.get({
        fileId: args.documentId,
        commentId: args.commentId,
        fields: 'resolved'
      });

      if (verifyComment.data.resolved) {
        return `Comment ${args.commentId} has been marked as resolved.`;
      } else {
        return `Attempted to resolve comment ${args.commentId}, but the resolved status may not persist in the Google Docs UI due to API limitations. The comment can be resolved manually in the Google Docs interface.`;
      }

    } catch (error: any) {
      log.error(`Error resolving comment: ${error.message || error}`);
      const errorDetails = error.response?.data?.error?.message || error.message || 'Unknown error';
      const errorCode = error.response?.data?.error?.code;
      throw new UserError(`Failed to resolve comment: ${errorDetails}${errorCode ? ` (Code: ${errorCode})` : ''}`);
    }
  }
});

server.addTool({
  name: 'deleteComment',
  description: 'Deletes a comment from the document.',
  parameters: DocumentIdParameter.extend({
    commentId: z.string().describe('The ID of the comment to delete')
  }),
  execute: async (args, { log, session }) => {
    log.info(`Deleting comment ${args.commentId} from doc ${args.documentId}`);

    try {
      const drive = google.drive({ version: 'v3', auth: getAuthClient(session) });

      await drive.comments.delete({
        fileId: args.documentId,
        commentId: args.commentId
      });

      return `Comment ${args.commentId} has been deleted.`;

    } catch (error: any) {
      log.error(`Error deleting comment: ${error.message || error}`);
      throw new UserError(`Failed to delete comment: ${error.message || 'Unknown error'}`);
    }
  }
});

// --- Add Stubs for other advanced features ---
// (findElement, getDocumentMetadata, replaceText, list management, image handling, section breaks, footnotes, etc.)
// Example Stub:
server.addTool({
name: 'findElement',
description: 'Finds elements (paragraphs, tables, etc.) based on various criteria. (Not Implemented)',
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
description: 'Finds specific text within a Google Document and applies character formatting (bold, italics, color, etc.) to the specified instance.',
parameters: z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  textToFind: z.string().min(1).describe('The exact text string to find and format.'),
  matchInstance: z.number().int().min(1).optional().default(1).describe('Which instance of the text to format (1st, 2nd, etc.). Defaults to 1.'),
  // Re-use optional Formatting Parameters (SHARED)
  bold: z.boolean().optional().describe('Apply bold formatting.'),
  italic: z.boolean().optional().describe('Apply italic formatting.'),
  underline: z.boolean().optional().describe('Apply underline formatting.'),
  strikethrough: z.boolean().optional().describe('Apply strikethrough formatting.'),
  fontSize: z.number().min(1).optional().describe('Set font size (in points, e.g., 12).'),
  fontFamily: z.string().optional().describe('Set font family (e.g., "Arial", "Times New Roman").'),
  foregroundColor: z.string()
    .refine((color) => /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color), {
      message: "Invalid hex color format (e.g., #FF0000 or #F00)"
    })
    .optional()
    .describe('Set text color using hex format (e.g., "#FF0000").'),
  backgroundColor: z.string()
    .refine((color) => /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color), {
      message: "Invalid hex color format (e.g., #00FF00 or #0F0)"
    })
    .optional()
    .describe('Set text background color using hex format (e.g., "#FFFF00").'),
  linkUrl: z.string().url().optional().describe('Make the text a hyperlink pointing to this URL.')
})
.refine(data => Object.keys(data).some(key => !['documentId', 'textToFind', 'matchInstance'].includes(key) && data[key as keyof typeof data] !== undefined), {
    message: "At least one formatting option (bold, italic, fontSize, etc.) must be provided."
}),
execute: async (args, { log, session }) => {
  // Adapt to use the new applyTextStyle implementation under the hood
  const docs = await getDocsClient(session);
  log.info(`Using formatMatchingText (legacy) for doc ${args.documentId}, target: "${args.textToFind}" (instance ${args.matchInstance})`);

  try {
    // Extract the style parameters
    const styleParams: TextStyleArgs = {};
    if (args.bold !== undefined) styleParams.bold = args.bold;
    if (args.italic !== undefined) styleParams.italic = args.italic;
    if (args.underline !== undefined) styleParams.underline = args.underline;
    if (args.strikethrough !== undefined) styleParams.strikethrough = args.strikethrough;
    if (args.fontSize !== undefined) styleParams.fontSize = args.fontSize;
    if (args.fontFamily !== undefined) styleParams.fontFamily = args.fontFamily;
    if (args.foregroundColor !== undefined) styleParams.foregroundColor = args.foregroundColor;
    if (args.backgroundColor !== undefined) styleParams.backgroundColor = args.backgroundColor;
    if (args.linkUrl !== undefined) styleParams.linkUrl = args.linkUrl;

    // Find the text range
    const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.textToFind, args.matchInstance);
    if (!range) {
      throw new UserError(`Could not find instance ${args.matchInstance} of text "${args.textToFind}".`);
    }

    // Build and execute the request
    const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(range.startIndex, range.endIndex, styleParams);
    if (!requestInfo) {
      return "No valid text styling options were provided.";
    }

    await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
    return `Successfully applied formatting to instance ${args.matchInstance} of "${args.textToFind}".`;
  } catch (error: any) {
    log.error(`Error in formatMatchingText for doc ${args.documentId}: ${error.message || error}`);
    if (error instanceof UserError) throw error;
    throw new UserError(`Failed to format text: ${error.message || 'Unknown error'}`);
  }
}
});

// === FIND AND REPLACE TOOL ===

server.addTool({
name: 'findAndReplace',
description: 'Finds all occurrences of a text string in a Google Doc and replaces them. Returns the number of replacements made.',
parameters: z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  findText: z.string().min(1).describe('The text to find.'),
  replaceText: z.string().describe('The replacement text.'),
  matchCase: z.boolean().optional().default(false).describe('Whether the search should be case-sensitive.'),
  tabId: z.string().optional().describe('Optional tab ID to restrict the replacement to.'),
}),
execute: async (args, { log, session }) => {
  const docs = await getDocsClient(session);
  log.info(`Find and replace in doc ${args.documentId}: "${args.findText}" → "${args.replaceText}" (matchCase: ${args.matchCase})`);

  const request: docs_v1.Schema$Request = {
    replaceAllText: {
      containsText: {
        text: args.findText,
        matchCase: args.matchCase ?? false,
      },
      replaceText: args.replaceText,
    }
  };

  // If tabId specified, add tabsCriteria
  if (args.tabId) {
    (request.replaceAllText as any).tabsCriteria = { tabIds: [args.tabId] };
  }

  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);

  // Extract occurrences changed from the reply
  const replies = response.replies || [];
  let occurrencesChanged = 0;
  for (const reply of replies) {
    if (reply.replaceAllText?.occurrencesChanged) {
      occurrencesChanged += reply.replaceAllText.occurrencesChanged;
    }
  }

  return `Replaced ${occurrencesChanged} occurrence(s) of "${args.findText}" with "${args.replaceText}".`;
}
});

// === INSPECT DOCUMENT STRUCTURE TOOL ===

server.addTool({
name: 'inspectDocStructure',
description: 'Analyzes and returns the structure of a Google Doc: paragraph/table/section counts, headers/footers presence, tab hierarchy. Use detailed mode for element-by-element listing.',
parameters: z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  detailed: z.boolean().optional().default(false).describe('If true, returns element-by-element listing with type, position, and text previews.'),
  tabId: z.string().optional().describe('Optional tab ID to inspect (defaults to first tab).'),
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

  const structure = GDocsHelpers.parseDocStructure(doc, args.detailed ?? false, args.tabId);
  return JSON.stringify(structure, null, 2);
}
});

// === IMPORT DOCX TOOL ===

server.addTool({
name: 'importDocx',
description: 'Converts a .docx file already in Google Drive into a Google Doc. Drive auto-converts the format. Returns the new Google Doc ID and link.',
parameters: z.object({
  fileId: z.string().describe('The Drive file ID of the .docx file to convert.'),
  targetFolderId: z.string().optional().describe('Optional folder ID to place the converted Google Doc in.'),
}),
execute: async (args, { log, session }) => {
  const drive = await getDriveClient(session);
  log.info(`Importing DOCX ${args.fileId} as Google Doc`);

  // Validate the source is a docx file
  const fileInfo = await drive.files.get({
    fileId: args.fileId,
    supportsAllDrives: true,
    fields: 'mimeType,name',
  });

  const mime = fileInfo.data.mimeType || '';
  if (mime !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    throw new UserError(`File is not a .docx file (mimeType: ${mime}). Only Word documents (.docx) can be imported.`);
  }

  // Copy the file with Google Docs mimeType — Drive auto-converts
  const copyMetadata: any = {
    mimeType: 'application/vnd.google-apps.document',
  };
  if (args.targetFolderId) {
    copyMetadata.parents = [args.targetFolderId];
  }

  const copyResponse = await drive.files.copy({
    fileId: args.fileId,
    requestBody: copyMetadata,
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
  });

  const newDoc = copyResponse.data;
  return `DOCX imported successfully as Google Doc:\n  Document ID: ${newDoc.id}\n  Title: ${newDoc.name}\n  Link: ${newDoc.webViewLink}`;
}
});

// === BATCH UPDATE DOC TOOL ===

server.addTool({
name: 'batchUpdateDoc',
description: 'Executes multiple document operations in a single batch. Supports: insert_text, delete_text, replace_text, format_text, update_paragraph_style, insert_table, insert_page_break, find_replace, create_bullet_list. Index-based operations are automatically sorted in descending order to prevent index shifting.',
parameters: z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  operations: z.array(BatchOperationSchema).min(1).max(50).describe('Array of operations to execute (1-50).'),
}),
execute: async (args, { log, session }) => {
  const docs = await getDocsClient(session);
  log.info(`Batch update on doc ${args.documentId}: ${args.operations.length} operation(s)`);

  // Map all operations to API requests
  const allRequests: docs_v1.Schema$Request[] = [];
  const opSummary: string[] = [];

  // Detect mixing of global (replace_text/find_replace) and index-based ops
  const hasGlobal = args.operations.some(op => op.type === 'replace_text' || op.type === 'find_replace');
  const hasIndexBased = args.operations.some(op => op.type !== 'replace_text' && op.type !== 'find_replace');

  if (hasGlobal && hasIndexBased) {
    throw new UserError(
      'Cannot mix global operations (replace_text, find_replace) with index-based operations in the same batch. ' +
      'Global replacements change document length and invalidate indices. Submit them in separate batches.'
    );
  }

  // For index-based batches, sort in descending index order to prevent shifting
  let opsToProcess: BatchOperation[];
  if (hasIndexBased) {
    opsToProcess = [...args.operations].sort((a, b) => {
      const aIdx = ('index' in a ? (a as any).index : (a as any).startIndex) ?? 0;
      const bIdx = ('index' in b ? (b as any).index : (b as any).startIndex) ?? 0;
      return bIdx - aIdx;
    });
  } else {
    opsToProcess = args.operations;
  }

  for (const op of opsToProcess) {
    const requests = GDocsHelpers.mapBatchOperationToRequest(op);
    if (requests.length > 0) {
      allRequests.push(...requests);
      opSummary.push(op.type);
    }
  }

  if (allRequests.length === 0) {
    return 'No valid operations to execute.';
  }

  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, allRequests);

  // Build summary
  const typeCounts: Record<string, number> = {};
  for (const t of opSummary) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const summary = Object.entries(typeCounts)
    .map(([type, count]) => `${count}x ${type}`)
    .join(', ');

  return `Batch update completed: ${args.operations.length} operation(s) executed (${summary}).`;
}
});
server.addTool({
name: 'importToGoogleDoc',
description: 'Import content (text, HTML, or markdown) into a new Google Doc. Google Drive auto-converts the content to Google Docs format.',
parameters: z.object({
  title: z.string().describe('Title for the new Google Doc.'),
  content: z.string().describe('The content to import (text, HTML, or markdown string).'),
  mimeType: z.enum([
    'text/plain',
    'text/html',
    'text/markdown',
  ]).optional().default('text/plain').describe('The mime type of the source content. For DOCX files already in Drive, use the importDocx tool instead.'),
  parentFolderId: z.string().optional().describe('Optional Drive folder ID to create the doc in.'),
}),
execute: async (args, { log, session }) => {
  const drive = await getDriveClient(session);
  log.info(`Importing content as Google Doc: "${args.title}" (mimeType: ${args.mimeType})`);

  try {
    const { Readable } = await import('stream');

    const fileMetadata: any = {
      name: args.title,
      mimeType: 'application/vnd.google-apps.document',
    };
    if (args.parentFolderId) {
      fileMetadata.parents = [args.parentFolderId];
    }

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: args.mimeType || 'text/plain',
        body: Readable.from(Buffer.from(args.content, 'utf-8')),
      },
      supportsAllDrives: true,
      fields: 'id,name,webViewLink,mimeType',
    });

    const doc = response.data;
    return `Google Doc created successfully:\n  Title: ${doc.name}\n  Document ID: ${doc.id}\n  Link: ${doc.webViewLink}`;
  } catch (error: any) {
    log.error(`Error importing to Google Doc: ${error.message || error}`);
    handleDriveError(error, 'import content to', args.parentFolderId || args.title);
  }
}
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

        // Pick the right MCP server based on MCP_SLUG
        const mcpToStart = MCP_SLUG === "google-calendar" ? calendarServer
                         : MCP_SLUG === "google-sheets"   ? sheetsServer
                         : MCP_SLUG === "google-gmail"    ? gmailServer
                         : MCP_SLUG === "google-slides"   ? slidesServer
                         : MCP_SLUG === "google-drive"    ? driveServer
                         : MCP_SLUG === "clickup"         ? clickUpServer
                         : MCP_SLUG === "slack-bot"        ? slackBotServer
                         : MCP_SLUG === "slack"           ? slackUserServer
                         : server; // default: google-docs

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

startServer();

process.on('SIGTERM', async () => {
  console.error('SIGTERM received, shutting down...');
  await closeDatabase();
  process.exit(0);
});
