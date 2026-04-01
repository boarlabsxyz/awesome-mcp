// src/google-slides/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { slides_v1, drive_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  handleCreatePresentation,
  handleGetPresentation,
  handleGetPage,
  handleGetPageThumbnail,
  handleBatchUpdatePresentation,
  handleListPresentationComments,
} from './toolHandlers.js';

const slidesServer = new FastMCP<UserSession>({
  name: 'Google Slides MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-slides'),
});

// --- Helpers ---
function getSlidesClient(session?: UserSession): slides_v1.Slides {
  if (session?.googleSlides) return session.googleSlides;
  throw new UserError("Google Slides client is not available. Make sure you have granted presentations access.");
}

function getDriveClient(session?: UserSession): drive_v3.Drive {
  if (session?.googleDrive) return session.googleDrive;
  throw new UserError("Google Drive client is not available. Make sure you have granted drive access.");
}

// === TOOL DEFINITIONS ===

slidesServer.addTool({
  name: 'createPresentation',
  description: 'Create a new Google Slides presentation.',
  parameters: z.object({
    title: z.string().optional().default('Untitled Presentation')
      .describe('The title of the new presentation.'),
  }),
  execute: async (args, { log, session }) => {
    return handleCreatePresentation(getSlidesClient(session), args, log);
  },
});

slidesServer.addTool({
  name: 'getPresentation',
  description: 'Get presentation metadata, slide IDs, and text content from all slides.',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation to retrieve.'),
  }),
  execute: async (args, { log, session }) => {
    return handleGetPresentation(getSlidesClient(session), args, log);
  },
});

slidesServer.addTool({
  name: 'getPage',
  description: 'Get details of a specific slide including shapes, tables, and other elements.',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation.'),
    pageObjectId: z.string().describe('The object ID of the slide/page to retrieve.'),
  }),
  execute: async (args, { log, session }) => {
    return handleGetPage(getSlidesClient(session), args, log);
  },
});

slidesServer.addTool({
  name: 'getPageThumbnail',
  description: 'Get a PNG thumbnail URL for a specific slide.',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation.'),
    pageObjectId: z.string().describe('The object ID of the slide/page.'),
    thumbnailSize: z.enum(['LARGE', 'MEDIUM', 'SMALL']).optional().default('MEDIUM')
      .describe('The size of the thumbnail.'),
  }),
  execute: async (args, { log, session }) => {
    return handleGetPageThumbnail(getSlidesClient(session), args, log);
  },
});

slidesServer.addTool({
  name: 'batchUpdatePresentation',
  description: 'Apply multiple operations to a presentation (create slides, add shapes, insert text, delete objects, etc.). Pass an array of Google Slides API request objects.',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation to update.'),
    requests: z.array(z.record(z.any())).describe('Array of Google Slides API request objects (e.g., [{createSlide: {...}}, {insertText: {...}}]).'),
  }),
  execute: async (args, { log, session }) => {
    return handleBatchUpdatePresentation(getSlidesClient(session), args, log);
  },
});

slidesServer.addTool({
  name: 'listPresentationComments',
  description: 'List comments on a Google Slides presentation (via Drive API).',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation.'),
  }),
  execute: async (args, { log, session }) => {
    return handleListPresentationComments(getDriveClient(session), args, log);
  },
});

export { slidesServer };
