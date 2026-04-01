// src/google-slides/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { slides_v1, drive_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

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
    const slides = getSlidesClient(session);
    log.info(`Creating presentation: "${args.title}"`);

    try {
      const response = await slides.presentations.create({
        requestBody: { title: args.title },
      });

      const presentation = response.data;
      return `Presentation created successfully!\n\n` +
        `**Title:** ${presentation.title}\n` +
        `**ID:** ${presentation.presentationId}\n` +
        `**URL:** https://docs.google.com/presentation/d/${presentation.presentationId}/edit`;
    } catch (error: any) {
      log.error(`Error creating presentation: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted presentations access.");
      throw new UserError(`Failed to create presentation: ${error.message || 'Unknown error'}`);
    }
  },
});

slidesServer.addTool({
  name: 'getPresentation',
  description: 'Get presentation metadata, slide IDs, and text content from all slides.',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation to retrieve.'),
  }),
  execute: async (args, { log, session }) => {
    const slides = getSlidesClient(session);
    log.info(`Getting presentation: ${args.presentationId}`);

    try {
      const response = await slides.presentations.get({
        presentationId: args.presentationId,
      });

      const presentation = response.data;
      const slidesList = presentation.slides || [];

      let result = `**Presentation:** ${presentation.title}\n`;
      result += `**ID:** ${presentation.presentationId}\n`;
      result += `**Slides:** ${slidesList.length}\n`;

      if (presentation.pageSize?.width && presentation.pageSize?.height) {
        const w = presentation.pageSize.width;
        const h = presentation.pageSize.height;
        result += `**Dimensions:** ${w.magnitude}${w.unit} x ${h.magnitude}${h.unit}\n`;
      }

      result += `\n**Slide IDs:**\n`;
      slidesList.forEach((slide, index) => {
        result += `  ${index + 1}. ${slide.objectId}\n`;
      });

      // Extract text from all slides
      result += `\n**Text Content:**\n`;
      slidesList.forEach((slide, index) => {
        const texts: string[] = [];
        if (slide.pageElements) {
          for (const element of slide.pageElements) {
            if (element.shape?.text?.textElements) {
              for (const te of element.shape.text.textElements) {
                if (te.textRun?.content) {
                  texts.push(te.textRun.content.trim());
                }
              }
            }
            if (element.table) {
              for (const row of element.table.tableRows || []) {
                for (const cell of row.tableCells || []) {
                  if (cell.text?.textElements) {
                    for (const te of cell.text.textElements) {
                      if (te.textRun?.content) {
                        texts.push(te.textRun.content.trim());
                      }
                    }
                  }
                }
              }
            }
          }
        }
        const textContent = texts.filter(t => t.length > 0).join(' | ');
        if (textContent) {
          result += `  Slide ${index + 1}: ${textContent}\n`;
        }
      });

      return result;
    } catch (error: any) {
      log.error(`Error getting presentation: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Presentation not found (ID: ${args.presentationId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this presentation.");
      throw new UserError(`Failed to get presentation: ${error.message || 'Unknown error'}`);
    }
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
    const slides = getSlidesClient(session);
    log.info(`Getting page ${args.pageObjectId} from presentation ${args.presentationId}`);

    try {
      const response = await slides.presentations.pages.get({
        presentationId: args.presentationId,
        pageObjectId: args.pageObjectId,
      });

      const page = response.data;
      let result = `**Page:** ${page.objectId}\n`;
      result += `**Type:** ${page.pageType || 'SLIDE'}\n`;

      const elements = page.pageElements || [];
      result += `**Elements:** ${elements.length}\n\n`;

      elements.forEach((element, index) => {
        result += `${index + 1}. **${element.objectId}**\n`;

        if (element.shape) {
          result += `   Type: Shape (${element.shape.shapeType || 'unknown'})\n`;
          if (element.shape.text?.textElements) {
            const texts: string[] = [];
            for (const te of element.shape.text.textElements) {
              if (te.textRun?.content) {
                texts.push(te.textRun.content.trim());
              }
            }
            const text = texts.filter(t => t.length > 0).join(' ');
            if (text) {
              result += `   Text: ${text}\n`;
            }
          }
        }

        if (element.table) {
          result += `   Type: Table (${element.table.rows} x ${element.table.columns})\n`;
          for (const row of element.table.tableRows || []) {
            const cells: string[] = [];
            for (const cell of row.tableCells || []) {
              if (cell.text?.textElements) {
                const cellTexts: string[] = [];
                for (const te of cell.text.textElements) {
                  if (te.textRun?.content) {
                    cellTexts.push(te.textRun.content.trim());
                  }
                }
                cells.push(cellTexts.filter(t => t.length > 0).join(' '));
              }
            }
            if (cells.some(c => c.length > 0)) {
              result += `   Row: ${cells.join(' | ')}\n`;
            }
          }
        }

        if (element.line) {
          result += `   Type: Line\n`;
        }

        if (element.image) {
          result += `   Type: Image\n`;
          if (element.image.sourceUrl) {
            result += `   Source: ${element.image.sourceUrl}\n`;
          }
        }

        if (element.size?.width && element.size?.height) {
          result += `   Size: ${element.size.width.magnitude}${element.size.width.unit} x ${element.size.height.magnitude}${element.size.height.unit}\n`;
        }

        result += `\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error getting page: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Page not found (ID: ${args.pageObjectId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this presentation.");
      throw new UserError(`Failed to get page: ${error.message || 'Unknown error'}`);
    }
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
    const slides = getSlidesClient(session);
    log.info(`Getting thumbnail for page ${args.pageObjectId}`);

    try {
      const response = await slides.presentations.pages.getThumbnail({
        presentationId: args.presentationId,
        pageObjectId: args.pageObjectId,
        'thumbnailProperties.mimeType': 'PNG',
        'thumbnailProperties.thumbnailSize': args.thumbnailSize,
      });

      const thumbnail = response.data;
      return `**Thumbnail for page ${args.pageObjectId}:**\n\n` +
        `**URL:** ${thumbnail.contentUrl}\n` +
        `**Size:** ${thumbnail.width}x${thumbnail.height}`;
    } catch (error: any) {
      log.error(`Error getting thumbnail: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Page not found (ID: ${args.pageObjectId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this presentation.");
      throw new UserError(`Failed to get thumbnail: ${error.message || 'Unknown error'}`);
    }
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
    const slides = getSlidesClient(session);
    log.info(`Batch updating presentation ${args.presentationId} with ${args.requests.length} request(s)`);

    try {
      const response = await slides.presentations.batchUpdate({
        presentationId: args.presentationId,
        requestBody: {
          requests: args.requests as slides_v1.Schema$Request[],
        },
      });

      const replies = response.data.replies || [];
      let result = `Batch update successful! ${args.requests.length} request(s) applied.\n\n`;

      if (replies.length > 0) {
        result += `**Replies:**\n`;
        replies.forEach((reply, index) => {
          const replyStr = JSON.stringify(reply, null, 2);
          if (replyStr !== '{}') {
            result += `  ${index + 1}. ${replyStr}\n`;
          }
        });
      }

      return result;
    } catch (error: any) {
      log.error(`Error in batch update: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Presentation not found (ID: ${args.presentationId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this presentation.");
      if (error.code === 400) throw new UserError(`Invalid request: ${error.message}`);
      throw new UserError(`Failed to batch update presentation: ${error.message || 'Unknown error'}`);
    }
  },
});

slidesServer.addTool({
  name: 'listPresentationComments',
  description: 'List comments on a Google Slides presentation (via Drive API).',
  parameters: z.object({
    presentationId: z.string().describe('The ID of the presentation.'),
  }),
  execute: async (args, { log, session }) => {
    const drive = getDriveClient(session);
    log.info(`Listing comments for presentation ${args.presentationId}`);

    try {
      const response = await drive.comments.list({
        fileId: args.presentationId,
        fields: '*',
      });

      const comments = response.data.comments || [];
      if (comments.length === 0) {
        return 'No comments found on this presentation.';
      }

      let result = `Found ${comments.length} comment(s):\n\n`;
      comments.forEach((comment, index) => {
        result += `${index + 1}. **${comment.author?.displayName || 'Unknown'}** (${comment.createdTime}):\n`;
        result += `   ${comment.content}\n`;
        if (comment.resolved) {
          result += `   *Resolved*\n`;
        }
        if (comment.replies && comment.replies.length > 0) {
          result += `   **Replies:**\n`;
          comment.replies.forEach((reply) => {
            result += `     - **${reply.author?.displayName || 'Unknown'}**: ${reply.content}\n`;
          });
        }
        result += `\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error listing comments: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Presentation not found (ID: ${args.presentationId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this presentation.");
      throw new UserError(`Failed to list comments: ${error.message || 'Unknown error'}`);
    }
  },
});

export { slidesServer };
