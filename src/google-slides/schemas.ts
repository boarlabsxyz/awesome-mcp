// src/google-slides/schemas.ts
// Zod parameter schemas for the Slides write tools. Separate from server.ts so
// the REST routes validate with exactly what the MCP tools validate, without
// importing a module that constructs a FastMCP server.

import { z } from 'zod';

export const createPresentationSchema = z.object({
  title: z.string().optional().default('Untitled Presentation')
    .describe('The title of the new presentation.'),
});

export const batchUpdatePresentationSchema = z.object({
  presentationId: z.string().describe('The ID of the presentation to update.'),
  requests: z.array(z.record(z.any())).describe('Array of Google Slides API request objects (e.g., [{createSlide: {...}}, {insertText: {...}}]).'),
  requiredRevisionId: z.string().min(1).optional()
    .describe('Optional Revision ID from getPresentation. If anyone changed the presentation since, Google rejects the whole batch and nothing is written.'),
});
