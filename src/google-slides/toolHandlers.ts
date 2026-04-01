// src/google-slides/toolHandlers.ts
import { UserError } from 'fastmcp';
import { slides_v1, drive_v3 } from 'googleapis';

type Log = { info: (msg: string) => void; error: (msg: string) => void };

/** Validate and return a Slides client from the session, or throw UserError. */
export function getSlidesClient(session?: { googleSlides?: slides_v1.Slides }): slides_v1.Slides {
  if (session?.googleSlides) return session.googleSlides;
  throw new UserError("Google Slides client is not available. Make sure you have granted presentations access.");
}

/** Validate and return a Drive client from the session, or throw UserError. */
export function getDriveClient(session?: { googleDrive?: drive_v3.Drive }): drive_v3.Drive {
  if (session?.googleDrive) return session.googleDrive;
  throw new UserError("Google Drive client is not available. Make sure you have granted drive access.");
}

/** Extract trimmed text runs from a TextElement array. */
export function extractTextRuns(textElements: slides_v1.Schema$TextElement[] | undefined): string[] {
  if (!textElements) return [];
  const texts: string[] = [];
  for (const te of textElements) {
    if (te.textRun?.content) {
      const trimmed = te.textRun.content.trim();
      if (trimmed.length > 0) texts.push(trimmed);
    }
  }
  return texts;
}

/** Extract all text from a page element's shapes and tables. */
export function extractElementTexts(element: slides_v1.Schema$PageElement): string[] {
  const texts: string[] = [];
  if (element.shape?.text?.textElements) {
    texts.push(...extractTextRuns(element.shape.text.textElements));
  }
  if (element.table) {
    for (const row of element.table.tableRows || []) {
      for (const cell of row.tableCells || []) {
        texts.push(...extractTextRuns(cell.text?.textElements));
      }
    }
  }
  return texts;
}

function handleSlidesError(error: any, context: string, notFoundMsg: string): never {
  if (error.code === 404) throw new UserError(notFoundMsg);
  if (error.code === 403) throw new UserError("Permission denied for this presentation.");
  if (error.code === 400) throw new UserError(`Invalid request: ${error.message}`);
  throw new UserError(`Failed to ${context}: ${error.message || 'Unknown error'}`);
}

export async function handleCreatePresentation(
  slides: slides_v1.Slides,
  args: { title: string },
  log: Log
): Promise<string> {
  log.info(`Creating presentation: "${args.title}"`);
  try {
    const response = await slides.presentations.create({
      requestBody: { title: args.title },
    });
    const p = response.data;
    return `Presentation created successfully!\n\n` +
      `**Title:** ${p.title}\n` +
      `**ID:** ${p.presentationId}\n` +
      `**URL:** https://docs.google.com/presentation/d/${p.presentationId}/edit`;
  } catch (error: any) {
    log.error(`Error creating presentation: ${error.message || error}`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted presentations access.");
    throw new UserError(`Failed to create presentation: ${error.message || 'Unknown error'}`);
  }
}

export async function handleGetPresentation(
  slides: slides_v1.Slides,
  args: { presentationId: string },
  log: Log
): Promise<string> {
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

    result += `\n**Text Content:**\n`;
    slidesList.forEach((slide, index) => {
      const texts: string[] = [];
      for (const element of slide.pageElements || []) {
        texts.push(...extractElementTexts(element));
      }
      const textContent = texts.join(' | ');
      if (textContent) {
        result += `  Slide ${index + 1}: ${textContent}\n`;
      }
    });

    return result;
  } catch (error: any) {
    log.error(`Error getting presentation: ${error.message || error}`);
    handleSlidesError(error, 'get presentation', `Presentation not found (ID: ${args.presentationId}).`);
  }
}

export async function handleGetPage(
  slides: slides_v1.Slides,
  args: { presentationId: string; pageObjectId: string },
  log: Log
): Promise<string> {
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
        const texts = extractTextRuns(element.shape.text?.textElements);
        if (texts.length > 0) {
          result += `   Text: ${texts.join(' ')}\n`;
        }
      }

      if (element.table) {
        result += `   Type: Table (${element.table.rows} x ${element.table.columns})\n`;
        for (const row of element.table.tableRows || []) {
          const cells: string[] = [];
          for (const cell of row.tableCells || []) {
            cells.push(extractTextRuns(cell.text?.textElements).join(' '));
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
    handleSlidesError(error, 'get page', `Page not found (ID: ${args.pageObjectId}).`);
  }
}

export async function handleGetPageThumbnail(
  slides: slides_v1.Slides,
  args: { presentationId: string; pageObjectId: string; thumbnailSize: string },
  log: Log
): Promise<string> {
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
    handleSlidesError(error, 'get thumbnail', `Page not found (ID: ${args.pageObjectId}).`);
  }
}

export async function handleBatchUpdatePresentation(
  slides: slides_v1.Slides,
  args: { presentationId: string; requests: Record<string, any>[] },
  log: Log
): Promise<string> {
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
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this presentation.");
    handleSlidesError(error, 'batch update presentation', `Presentation not found (ID: ${args.presentationId}).`);
  }
}

export async function handleListPresentationComments(
  drive: drive_v3.Drive,
  args: { presentationId: string },
  log: Log
): Promise<string> {
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
    handleSlidesError(error, 'list comments', `Presentation not found (ID: ${args.presentationId}).`);
  }
}
