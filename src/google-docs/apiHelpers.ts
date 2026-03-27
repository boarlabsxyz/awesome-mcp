// src/googleDocsApiHelpers.ts
import { google, docs_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { UserError } from 'fastmcp';
import { TextStyleArgs, ParagraphStyleArgs, hexToRgbColor, NotImplementedError, BatchOperation } from '../types.js';

type Docs = docs_v1.Docs; // Alias for convenience

// --- Constants ---
const MAX_BATCH_UPDATE_REQUESTS = 50; // Google API limits batch size

// --- Core Helper to Execute Batch Updates ---
export async function executeBatchUpdate(docs: Docs, documentId: string, requests: docs_v1.Schema$Request[]): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
if (!requests || requests.length === 0) {
// console.warn("executeBatchUpdate called with no requests.");
return {}; // Nothing to do
}

    // TODO: Consider splitting large request arrays into multiple batches if needed
    if (requests.length > MAX_BATCH_UPDATE_REQUESTS) {
         console.warn(`Attempting batch update with ${requests.length} requests, exceeding typical limits. May fail.`);
    }

    try {
        const response = await docs.documents.batchUpdate({
            documentId: documentId,
            requestBody: { requests },
        });
        return response.data;
    } catch (error: any) {
        console.error(`Google API batchUpdate Error for doc ${documentId}:`, error.response?.data || error.message);
        // Translate common API errors to UserErrors
        if (error.code === 400 && error.message.includes('Invalid requests')) {
             // Try to extract more specific info if available
             const details = error.response?.data?.error?.details;
             let detailMsg = '';
             if (details && Array.isArray(details)) {
                 detailMsg = details.map(d => d.description || JSON.stringify(d)).join('; ');
             }
            throw new UserError(`Invalid request sent to Google Docs API. Details: ${detailMsg || error.message}`);
        }
        if (error.code === 404) throw new UserError(`Document not found (ID: ${documentId}). Check the ID.`);
        if (error.code === 403) throw new UserError(`Permission denied for document (ID: ${documentId}). Ensure the authenticated user has edit access.`);
        // Generic internal error for others
        throw new Error(`Google API Error (${error.code}): ${error.message}`);
    }

}

// --- Text Finding Helper ---
// This improved version is more robust in handling various text structure scenarios
export async function findTextRange(docs: Docs, documentId: string, textToFind: string, instance: number = 1): Promise<{ startIndex: number; endIndex: number } | null> {
try {
    // Request more detailed information about the document structure
    const res = await docs.documents.get({
        documentId,
        // Request more fields to handle various container types (not just paragraphs)
        fields: 'body(content(paragraph(elements(startIndex,endIndex,textRun(content))),table,sectionBreak,tableOfContents,startIndex,endIndex))',
    });

    if (!res.data.body?.content) {
        console.warn(`No content found in document ${documentId}`);
        return null;
    }

    // More robust text collection and index tracking
    let fullText = '';
    const segments: { text: string, start: number, end: number }[] = [];

    // Process all content elements, including structural ones
    const collectTextFromContent = (content: any[]) => {
        content.forEach(element => {
            // Handle paragraph elements
            if (element.paragraph?.elements) {
                element.paragraph.elements.forEach((pe: any) => {
                    if (pe.textRun?.content && pe.startIndex !== undefined && pe.endIndex !== undefined) {
                        const content = pe.textRun.content;
                        fullText += content;
                        segments.push({
                            text: content,
                            start: pe.startIndex,
                            end: pe.endIndex
                        });
                    }
                });
            }

            // Handle table elements - this is simplified and might need expansion
            if (element.table && element.table.tableRows) {
                element.table.tableRows.forEach((row: any) => {
                    if (row.tableCells) {
                        row.tableCells.forEach((cell: any) => {
                            if (cell.content) {
                                collectTextFromContent(cell.content);
                            }
                        });
                    }
                });
            }

            // Add handling for other structural elements as needed
        });
    };

    collectTextFromContent(res.data.body.content);

    // Sort segments by starting position to ensure correct ordering
    segments.sort((a, b) => a.start - b.start);

    console.log(`Document ${documentId} contains ${segments.length} text segments and ${fullText.length} characters in total.`);

    // Find the specified instance of the text
    let startIndex = -1;
    let endIndex = -1;
    let foundCount = 0;
    let searchStartIndex = 0;

    while (foundCount < instance) {
        const currentIndex = fullText.indexOf(textToFind, searchStartIndex);
        if (currentIndex === -1) {
            console.log(`Search text "${textToFind}" not found for instance ${foundCount + 1} (requested: ${instance})`);
            break;
        }

        foundCount++;
        console.log(`Found instance ${foundCount} of "${textToFind}" at position ${currentIndex} in full text`);

        if (foundCount === instance) {
            const targetStartInFullText = currentIndex;
            const targetEndInFullText = currentIndex + textToFind.length;
            let currentPosInFullText = 0;

            console.log(`Target text range in full text: ${targetStartInFullText}-${targetEndInFullText}`);

            for (const seg of segments) {
                const segStartInFullText = currentPosInFullText;
                const segTextLength = seg.text.length;
                const segEndInFullText = segStartInFullText + segTextLength;

                // Map from reconstructed text position to actual document indices
                if (startIndex === -1 && targetStartInFullText >= segStartInFullText && targetStartInFullText < segEndInFullText) {
                    startIndex = seg.start + (targetStartInFullText - segStartInFullText);
                    console.log(`Mapped start to segment ${seg.start}-${seg.end}, position ${startIndex}`);
                }

                if (targetEndInFullText > segStartInFullText && targetEndInFullText <= segEndInFullText) {
                    endIndex = seg.start + (targetEndInFullText - segStartInFullText);
                    console.log(`Mapped end to segment ${seg.start}-${seg.end}, position ${endIndex}`);
                    break;
                }

                currentPosInFullText = segEndInFullText;
            }

            if (startIndex === -1 || endIndex === -1) {
                console.warn(`Failed to map text "${textToFind}" instance ${instance} to actual document indices`);
                // Reset and try next occurrence
                startIndex = -1;
                endIndex = -1;
                searchStartIndex = currentIndex + 1;
                foundCount--;
                continue;
            }

            console.log(`Successfully mapped "${textToFind}" to document range ${startIndex}-${endIndex}`);
            return { startIndex, endIndex };
        }

        // Prepare for next search iteration
        searchStartIndex = currentIndex + 1;
    }

    console.warn(`Could not find instance ${instance} of text "${textToFind}" in document ${documentId}`);
    return null; // Instance not found or mapping failed for all attempts
} catch (error: any) {
    console.error(`Error finding text "${textToFind}" in doc ${documentId}: ${error.message || 'Unknown error'}`);
    if (error.code === 404) throw new UserError(`Document not found while searching text (ID: ${documentId}).`);
    if (error.code === 403) throw new UserError(`Permission denied while searching text in doc ${documentId}.`);
    throw new Error(`Failed to retrieve doc for text searching: ${error.message || 'Unknown error'}`);
}
}

// --- Paragraph Boundary Helper ---
// Enhanced version to handle document structural elements more robustly
export async function getParagraphRange(docs: Docs, documentId: string, indexWithin: number): Promise<{ startIndex: number; endIndex: number } | null> {
try {
    console.log(`Finding paragraph containing index ${indexWithin} in document ${documentId}`);

    // Request more detailed document structure to handle nested elements
    const res = await docs.documents.get({
        documentId,
        // Request more comprehensive structure information
        fields: 'body(content(startIndex,endIndex,paragraph,table,sectionBreak,tableOfContents))',
    });

    if (!res.data.body?.content) {
        console.warn(`No content found in document ${documentId}`);
        return null;
    }

    // Find paragraph containing the index
    // We'll look at all structural elements recursively
    const findParagraphInContent = (content: any[]): { startIndex: number; endIndex: number } | null => {
        for (const element of content) {
            // Check if we have element boundaries defined
            if (element.startIndex !== undefined && element.endIndex !== undefined) {
                // Check if index is within this element's range first
                if (indexWithin >= element.startIndex && indexWithin < element.endIndex) {
                    // If it's a paragraph, we've found our target
                    if (element.paragraph) {
                        console.log(`Found paragraph containing index ${indexWithin}, range: ${element.startIndex}-${element.endIndex}`);
                        return {
                            startIndex: element.startIndex,
                            endIndex: element.endIndex
                        };
                    }

                    // If it's a table, we need to check cells recursively
                    if (element.table && element.table.tableRows) {
                        console.log(`Index ${indexWithin} is within a table, searching cells...`);
                        for (const row of element.table.tableRows) {
                            if (row.tableCells) {
                                for (const cell of row.tableCells) {
                                    if (cell.content) {
                                        const result = findParagraphInContent(cell.content);
                                        if (result) return result;
                                    }
                                }
                            }
                        }
                    }

                    // For other structural elements, we didn't find a paragraph
                    // but we know the index is within this element
                    console.warn(`Index ${indexWithin} is within element (${element.startIndex}-${element.endIndex}) but not in a paragraph`);
                }
            }
        }

        return null;
    };

    const paragraphRange = findParagraphInContent(res.data.body.content);

    if (!paragraphRange) {
        console.warn(`Could not find paragraph containing index ${indexWithin}`);
    } else {
        console.log(`Returning paragraph range: ${paragraphRange.startIndex}-${paragraphRange.endIndex}`);
    }

    return paragraphRange;

} catch (error: any) {
    console.error(`Error getting paragraph range for index ${indexWithin} in doc ${documentId}: ${error.message || 'Unknown error'}`);
    if (error.code === 404) throw new UserError(`Document not found while finding paragraph (ID: ${documentId}).`);
    if (error.code === 403) throw new UserError(`Permission denied while accessing doc ${documentId}.`);
    throw new Error(`Failed to find paragraph: ${error.message || 'Unknown error'}`);
}
}

// --- Style Request Builders ---

export function buildUpdateTextStyleRequest(
startIndex: number,
endIndex: number,
style: TextStyleArgs
): { request: docs_v1.Schema$Request, fields: string[] } | null {
    const textStyle: docs_v1.Schema$TextStyle = {};
const fieldsToUpdate: string[] = [];

    if (style.bold !== undefined) { textStyle.bold = style.bold; fieldsToUpdate.push('bold'); }
    if (style.italic !== undefined) { textStyle.italic = style.italic; fieldsToUpdate.push('italic'); }
    if (style.underline !== undefined) { textStyle.underline = style.underline; fieldsToUpdate.push('underline'); }
    if (style.strikethrough !== undefined) { textStyle.strikethrough = style.strikethrough; fieldsToUpdate.push('strikethrough'); }
    if (style.fontSize !== undefined) { textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' }; fieldsToUpdate.push('fontSize'); }
    if (style.fontFamily !== undefined) { textStyle.weightedFontFamily = { fontFamily: style.fontFamily }; fieldsToUpdate.push('weightedFontFamily'); }
    if (style.foregroundColor !== undefined) {
        const rgbColor = hexToRgbColor(style.foregroundColor);
        if (!rgbColor) throw new UserError(`Invalid foreground hex color format: ${style.foregroundColor}`);
        textStyle.foregroundColor = { color: { rgbColor: rgbColor } }; fieldsToUpdate.push('foregroundColor');
    }
     if (style.backgroundColor !== undefined) {
        const rgbColor = hexToRgbColor(style.backgroundColor);
        if (!rgbColor) throw new UserError(`Invalid background hex color format: ${style.backgroundColor}`);
        textStyle.backgroundColor = { color: { rgbColor: rgbColor } }; fieldsToUpdate.push('backgroundColor');
    }
    if (style.linkUrl !== undefined) {
        textStyle.link = { url: style.linkUrl }; fieldsToUpdate.push('link');
    }
    // TODO: Handle clearing formatting

    if (fieldsToUpdate.length === 0) return null; // No styles to apply

    const request: docs_v1.Schema$Request = {
        updateTextStyle: {
            range: { startIndex, endIndex },
            textStyle: textStyle,
            fields: fieldsToUpdate.join(','),
        }
    };
    return { request, fields: fieldsToUpdate };

}

export function buildUpdateParagraphStyleRequest(
startIndex: number,
endIndex: number,
style: ParagraphStyleArgs
): { request: docs_v1.Schema$Request, fields: string[] } | null {
    // Create style object and track which fields to update
    const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
    const fieldsToUpdate: string[] = [];

    console.log(`Building paragraph style request for range ${startIndex}-${endIndex} with options:`, style);

    // Process alignment option (LEFT, CENTER, RIGHT, JUSTIFIED)
    if (style.alignment !== undefined) {
        paragraphStyle.alignment = style.alignment;
        fieldsToUpdate.push('alignment');
        console.log(`Setting alignment to ${style.alignment}`);
    }

    // Process indentation options
    if (style.indentStart !== undefined) {
        paragraphStyle.indentStart = { magnitude: style.indentStart, unit: 'PT' };
        fieldsToUpdate.push('indentStart');
        console.log(`Setting left indent to ${style.indentStart}pt`);
    }

    if (style.indentEnd !== undefined) {
        paragraphStyle.indentEnd = { magnitude: style.indentEnd, unit: 'PT' };
        fieldsToUpdate.push('indentEnd');
        console.log(`Setting right indent to ${style.indentEnd}pt`);
    }

    // Process spacing options
    if (style.spaceAbove !== undefined) {
        paragraphStyle.spaceAbove = { magnitude: style.spaceAbove, unit: 'PT' };
        fieldsToUpdate.push('spaceAbove');
        console.log(`Setting space above to ${style.spaceAbove}pt`);
    }

    if (style.spaceBelow !== undefined) {
        paragraphStyle.spaceBelow = { magnitude: style.spaceBelow, unit: 'PT' };
        fieldsToUpdate.push('spaceBelow');
        console.log(`Setting space below to ${style.spaceBelow}pt`);
    }

    // Process named style types (headings, etc.)
    if (style.namedStyleType !== undefined) {
        paragraphStyle.namedStyleType = style.namedStyleType;
        fieldsToUpdate.push('namedStyleType');
        console.log(`Setting named style to ${style.namedStyleType}`);
    }

    // Process page break control
    if (style.keepWithNext !== undefined) {
        paragraphStyle.keepWithNext = style.keepWithNext;
        fieldsToUpdate.push('keepWithNext');
        console.log(`Setting keepWithNext to ${style.keepWithNext}`);
    }

    // Verify we have styles to apply
    if (fieldsToUpdate.length === 0) {
        console.warn("No paragraph styling options were provided");
        return null; // No styles to apply
    }

    // Build the request object
    const request: docs_v1.Schema$Request = {
        updateParagraphStyle: {
            range: { startIndex, endIndex },
            paragraphStyle: paragraphStyle,
            fields: fieldsToUpdate.join(','),
        }
    };

    console.log(`Created paragraph style request with fields: ${fieldsToUpdate.join(', ')}`);
    return { request, fields: fieldsToUpdate };
}

// --- Specific Feature Helpers ---

export async function createTable(docs: Docs, documentId: string, rows: number, columns: number, index: number): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    if (rows < 1 || columns < 1) {
        throw new UserError("Table must have at least 1 row and 1 column.");
    }
    const request: docs_v1.Schema$Request = {
insertTable: {
location: { index },
rows: rows,
columns: columns,
}
};
return executeBatchUpdate(docs, documentId, [request]);
}

export async function insertText(docs: Docs, documentId: string, text: string, index: number): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    if (!text) return {}; // Nothing to insert
    const request: docs_v1.Schema$Request = {
insertText: {
location: { index },
text: text,
}
};
return executeBatchUpdate(docs, documentId, [request]);
}

// --- Complex / Stubbed Helpers ---

export async function findParagraphsMatchingStyle(
docs: Docs,
documentId: string,
styleCriteria: any // Define a proper type for criteria (e.g., { fontFamily: 'Arial', bold: true })
): Promise<{ startIndex: number; endIndex: number }[]> {
// TODO: Implement logic
// 1. Get document content with paragraph elements and their styles.
// 2. Iterate through paragraphs.
// 3. For each paragraph, check if its computed style matches the criteria.
// 4. Return ranges of matching paragraphs.
console.warn("findParagraphsMatchingStyle is not implemented.");
throw new NotImplementedError("Finding paragraphs by style criteria is not yet implemented.");
// return [];
}

export async function detectAndFormatLists(
docs: Docs,
documentId: string,
startIndex?: number,
endIndex?: number
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
// TODO: Implement complex logic
// 1. Get document content (paragraphs, text runs) in the specified range (or whole doc).
// 2. Iterate through paragraphs.
// 3. Identify sequences of paragraphs starting with list-like markers (e.g., "-", "*", "1.", "a)").
// 4. Determine nesting levels based on indentation or marker patterns.
// 5. Generate CreateParagraphBulletsRequests for the identified sequences.
// 6. Potentially delete the original marker text.
// 7. Execute the batch update.
console.warn("detectAndFormatLists is not implemented.");
throw new NotImplementedError("Automatic list detection and formatting is not yet implemented.");
// return {};
}

export async function addCommentHelper(docs: Docs, documentId: string, text: string, startIndex: number, endIndex: number): Promise<void> {
// NOTE: Adding comments typically requires the Google Drive API v3 and different scopes!
// 'https://www.googleapis.com/auth/drive' or more specific comment scopes.
// This helper is a placeholder assuming Drive API client (`drive`) is available and authorized.
/*
const drive = google.drive({version: 'v3', auth: authClient}); // Assuming authClient is available
await drive.comments.create({
fileId: documentId,
requestBody: {
content: text,
anchor: JSON.stringify({ // Anchor format might need verification
'type': 'workbook#textAnchor', // Or appropriate type for Docs
'refs': [{
'docRevisionId': 'head', // Or specific revision
'range': {
'start': startIndex,
'end': endIndex,
}
}]
})
},
fields: 'id'
});
*/
console.warn("addCommentHelper requires Google Drive API and is not implemented.");
throw new NotImplementedError("Adding comments requires Drive API setup and is not yet implemented.");
}

// --- Image Insertion Helpers ---

/**
 * Inserts an inline image into a document from a publicly accessible URL
 * @param docs - Google Docs API client
 * @param documentId - The document ID
 * @param imageUrl - Publicly accessible URL to the image
 * @param index - Position in the document where image should be inserted (1-based)
 * @param width - Optional width in points
 * @param height - Optional height in points
 * @returns Promise with batch update response
 */
export async function insertInlineImage(
    docs: Docs,
    documentId: string,
    imageUrl: string,
    index: number,
    width?: number,
    height?: number
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    // Validate URL format
    try {
        new URL(imageUrl);
    } catch (e) {
        throw new UserError(`Invalid image URL format: ${imageUrl}`);
    }

    // Build the insertInlineImage request
    const request: docs_v1.Schema$Request = {
        insertInlineImage: {
            location: { index },
            uri: imageUrl,
            ...(width && height && {
                objectSize: {
                    height: { magnitude: height, unit: 'PT' },
                    width: { magnitude: width, unit: 'PT' }
                }
            })
        }
    };

    return executeBatchUpdate(docs, documentId, [request]);
}

// --- URL validation for SSRF protection ---

const PRIVATE_CIDR_PATTERNS = [
    /^127\./,                          // 127.0.0.0/8 loopback
    /^10\./,                           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12
    /^192\.168\./,                     // 192.168.0.0/16
    /^169\.254\./,                     // link-local / cloud metadata
    /^0\./,                            // 0.0.0.0/8
    /^::1$/,                           // IPv6 loopback
    /^f[cd]/i,                         // IPv6 ULA (fc00::/7)
    /^fe80:/i,                         // IPv6 link-local
];

/**
 * Validates that a URL uses http/https and parses it.
 * Throws UserError for invalid or disallowed schemes.
 */
export function validateFetchUrl(url: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new UserError(`Invalid image URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new UserError(`Only http and https URLs are allowed, got: ${parsed.protocol}`);
    }
    return parsed;
}

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'kubernetes.default',
    'kubernetes.default.svc',
    'metadata.google.internal',
]);

/**
 * Resolves a hostname to IP addresses and rejects private/internal ranges.
 * Prevents SSRF attacks targeting cloud metadata, localhost, or internal services.
 */
export async function rejectPrivateAddress(hostname: string): Promise<void> {
    // Reject known dangerous hostnames before DNS resolution
    let normalised = hostname.toLowerCase();
    while (normalised.endsWith('.')) normalised = normalised.slice(0, -1);
    if (!normalised || BLOCKED_HOSTNAMES.has(normalised)) {
        throw new UserError(`Blocked hostname: ${hostname}. Refusing to fetch.`);
    }

    const dns = await import('dns');
    const { promisify } = await import('util');
    const resolve4 = promisify(dns.resolve4);
    const resolve6 = promisify(dns.resolve6);

    // Collect all resolved IPs
    const ips: string[] = [];
    try { ips.push(...await resolve4(normalised)); } catch { /* no A records */ }
    try { ips.push(...await resolve6(normalised)); } catch { /* no AAAA records */ }

    // If hostname is already an IP literal, check it directly
    if (ips.length === 0) {
        ips.push(normalised);
    }

    for (const ip of ips) {
        for (const pattern of PRIVATE_CIDR_PATTERNS) {
            if (pattern.test(ip)) {
                throw new UserError(`Image URL resolves to a private/internal address (${ip}). Refusing to fetch.`);
            }
        }
    }
}

/**
 * Uploads a local image file to Google Drive and returns its public URL
 * @param drive - Google Drive API client
 * @param localFilePath - Path to the local image file
 * @param parentFolderId - Optional parent folder ID (defaults to root)
 * @returns Promise with the public webContentLink URL
 */
export async function uploadImageToDrive(
    drive: any, // drive_v3.Drive type
    localFilePath: string | undefined,
    parentFolderId?: string,
    imageBuffer?: Buffer,
    fileName?: string,
    imageUrl?: string
): Promise<string> {
    const path = await import('path');
    const { Readable } = await import('stream');

    const mimeTypeMap: { [key: string]: string } = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
    };

    let resolvedFileName: string;
    let mimeType: string;
    let body: any;

    if (imageBuffer && fileName) {
        // Remote deployment: use provided buffer and filename
        resolvedFileName = fileName;
        const ext = path.extname(fileName).toLowerCase();
        mimeType = mimeTypeMap[ext] || 'application/octet-stream';
        body = Readable.from(imageBuffer);
    } else if (imageUrl) {
        // Remote deployment: fetch from URL with SSRF and size protections
        const validated = validateFetchUrl(imageUrl);
        await rejectPrivateAddress(validated.hostname);

        const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
        const FETCH_TIMEOUT_MS = 30_000;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(imageUrl, { signal: controller.signal, redirect: 'follow' });
        } catch (err: any) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new UserError(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${imageUrl}`);
            }
            throw new UserError(`Failed to fetch image from URL: ${err.message}`);
        }
        clearTimeout(timeout);

        if (!response.ok) {
            throw new UserError(`Failed to fetch image from URL (${response.status}): ${imageUrl}`);
        }

        // Reject early if Content-Length exceeds limit
        const contentLength = Number(response.headers.get('content-length') || '0');
        if (contentLength > MAX_IMAGE_SIZE) {
            throw new UserError(`Image too large (${contentLength} bytes, max ${MAX_IMAGE_SIZE}): ${imageUrl}`);
        }

        // Stream with size enforcement instead of buffering entire response
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        const reader = response.body?.getReader();
        if (!reader) {
            throw new UserError(`No response body from URL: ${imageUrl}`);
        }
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                totalBytes += value.byteLength;
                if (totalBytes > MAX_IMAGE_SIZE) {
                    reader.cancel();
                    throw new UserError(`Image exceeds max size (${MAX_IMAGE_SIZE} bytes): ${imageUrl}`);
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        // Derive filename from URL path
        resolvedFileName = fileName || path.basename(validated.pathname) || 'image.png';
        const ext = path.extname(resolvedFileName).toLowerCase();
        mimeType = mimeTypeMap[ext] || response.headers.get('content-type') || 'application/octet-stream';
        body = Readable.from(Buffer.concat(chunks.map(c => Buffer.from(c))));
    } else if (localFilePath) {
        // Local deployment: read from filesystem
        const fs = await import('fs');
        if (!fs.existsSync(localFilePath)) {
            throw new UserError(`Image file not found: ${localFilePath}`);
        }
        resolvedFileName = path.basename(localFilePath);
        const ext = path.extname(localFilePath).toLowerCase();
        mimeType = mimeTypeMap[ext] || 'application/octet-stream';
        body = fs.createReadStream(localFilePath);
    } else {
        throw new UserError('Either localFilePath, imageUrl, or imageBuffer + fileName must be provided.');
    }

    // Upload file to Drive
    const fileMetadata: any = {
        name: resolvedFileName,
        mimeType: mimeType
    };

    if (parentFolderId) {
        fileMetadata.parents = [parentFolderId];
    }

    const media = {
        mimeType: mimeType,
        body: body
    };

    const uploadResponse = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        supportsAllDrives: true,
        fields: 'id,webViewLink,webContentLink'
    });

    const fileId = uploadResponse.data.id;
    if (!fileId) {
        throw new Error('Failed to upload image to Drive - no file ID returned');
    }

    // Make the file publicly readable
    await drive.permissions.create({
        fileId: fileId,
        supportsAllDrives: true,
        requestBody: {
            role: 'reader',
            type: 'anyone'
        }
    });

    // Get the webContentLink
    const fileInfo = await drive.files.get({
        fileId: fileId,
        supportsAllDrives: true,
        fields: 'webContentLink'
    });

    const webContentLink = fileInfo.data.webContentLink;
    if (!webContentLink) {
        throw new Error('Failed to get public URL for uploaded image');
    }

    return webContentLink;
}

/**
 * Makes an existing Drive file publicly readable and returns its webContentLink.
 * Useful when the image is already in Drive and just needs to be inserted into a doc.
 */
export async function getPublicUrlForDriveFile(
    drive: any,
    fileId: string
): Promise<string> {
    // Fetch metadata first to validate file type before publishing
    const fileInfo = await drive.files.get({
        fileId: fileId,
        supportsAllDrives: true,
        fields: 'mimeType,webContentLink'
    });

    const fileMimeType: string | undefined = fileInfo.data.mimeType;
    if (!fileMimeType || !fileMimeType.startsWith('image/')) {
        throw new UserError(
            `Drive file ${fileId} is not an image (mimeType: ${fileMimeType || 'unknown'}). Only image files can be inserted.`
        );
    }

    // Now safe to make it publicly readable
    await drive.permissions.create({
        fileId: fileId,
        supportsAllDrives: true,
        requestBody: {
            role: 'reader',
            type: 'anyone'
        }
    });

    const webContentLink = fileInfo.data.webContentLink;
    if (!webContentLink) {
        throw new Error('Failed to get public URL for Drive file. Ensure the file is a binary file (image), not a Google Docs editor file.');
    }

    return webContentLink;
}

// --- Image Source Validation ---

export interface ImageSourceArgs {
    imageUrl?: string;
    driveFileId?: string;
    localImagePath?: string;
    imageBase64?: string;
    fileName?: string;
}

/**
 * Validates that exactly one image source is provided and returns
 * which strategy to use: 'driveFile', 'upload', or throws on invalid input.
 */
export function validateImageSource(args: ImageSourceArgs): 'driveFile' | 'upload' {
    const hasSource = args.imageUrl || args.driveFileId || args.localImagePath || args.imageBase64;
    if (!hasSource) {
        throw new UserError('Provide one of: imageUrl, driveFileId, localImagePath, or imageBase64.');
    }
    if (args.imageBase64 && !args.fileName) {
        throw new UserError('fileName is required when using imageBase64 (needed for MIME type detection).');
    }
    return args.driveFileId ? 'driveFile' : 'upload';
}

// --- Tab Management Helpers ---

/**
 * Interface for a tab with hierarchy level information
 */
export interface TabWithLevel extends docs_v1.Schema$Tab {
    level: number;
}

/**
 * Recursively collect all tabs from a document in a flat list with hierarchy info
 * @param doc - The Google Doc document object
 * @returns Array of tabs with nesting level information
 */
export function getAllTabs(doc: docs_v1.Schema$Document): TabWithLevel[] {
    const allTabs: TabWithLevel[] = [];
    if (!doc.tabs || doc.tabs.length === 0) {
        return allTabs;
    }

    for (const tab of doc.tabs) {
        addCurrentAndChildTabs(tab, allTabs, 0);
    }
    return allTabs;
}

/**
 * Recursive helper to add tabs with their nesting level
 * @param tab - The tab to add
 * @param allTabs - The accumulator array
 * @param level - Current nesting level (0 for top-level)
 */
function addCurrentAndChildTabs(tab: docs_v1.Schema$Tab, allTabs: TabWithLevel[], level: number): void {
    allTabs.push({ ...tab, level });
    if (tab.childTabs && tab.childTabs.length > 0) {
        for (const childTab of tab.childTabs) {
            addCurrentAndChildTabs(childTab, allTabs, level + 1);
        }
    }
}

/**
 * Get the text length from a DocumentTab
 * @param documentTab - The DocumentTab object
 * @returns Total character count
 */
export function getTabTextLength(documentTab: docs_v1.Schema$DocumentTab | undefined): number {
    let totalLength = 0;

    if (!documentTab?.body?.content) {
        return 0;
    }

    documentTab.body.content.forEach((element: any) => {
        // Handle paragraphs
        if (element.paragraph?.elements) {
            element.paragraph.elements.forEach((pe: any) => {
                if (pe.textRun?.content) {
                    totalLength += pe.textRun.content.length;
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
                                totalLength += pe.textRun.content.length;
                            }
                        });
                    });
                });
            });
        }
    });

    return totalLength;
}

/**
 * Find a specific tab by ID in a document (searches recursively through child tabs)
 * @param doc - The Google Doc document object
 * @param tabId - The tab ID to search for
 * @returns The tab object if found, null otherwise
 */
export function findTabById(doc: docs_v1.Schema$Document, tabId: string): docs_v1.Schema$Tab | null {
    if (!doc.tabs || doc.tabs.length === 0) {
        return null;
    }

    // Helper function to search through tabs recursively
    const searchTabs = (tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Tab | null => {
        for (const tab of tabs) {
            if (tab.tabProperties?.tabId === tabId) {
                return tab;
            }
            // Recursively search child tabs
            if (tab.childTabs && tab.childTabs.length > 0) {
                const found = searchTabs(tab.childTabs);
                if (found) return found;
            }
        }
        return null;
    };

    return searchTabs(doc.tabs);
}

// --- Batch Operation Mapper ---

/**
 * Maps a BatchOperation to Google Docs API request(s). Pure function.
 */
export function mapBatchOperationToRequest(op: BatchOperation): docs_v1.Schema$Request[] {
    switch (op.type) {
        case 'insert_text':
            return [{
                insertText: {
                    location: { index: op.index },
                    text: op.text,
                }
            }];

        case 'delete_text':
            return [{
                deleteContentRange: {
                    range: { startIndex: op.startIndex, endIndex: op.endIndex }
                }
            }];

        case 'replace_text':
        case 'find_replace':
            return [{
                replaceAllText: {
                    containsText: { text: op.findText, matchCase: op.matchCase ?? false },
                    replaceText: op.replaceText,
                }
            }];

        case 'format_text': {
            const result = buildUpdateTextStyleRequest(op.startIndex, op.endIndex, op.style);
            return result ? [result.request] : [];
        }

        case 'update_paragraph_style': {
            const result = buildUpdateParagraphStyleRequest(op.startIndex, op.endIndex, op.style);
            return result ? [result.request] : [];
        }

        case 'insert_table':
            return [{
                insertTable: {
                    location: { index: op.index },
                    rows: op.rows,
                    columns: op.columns,
                }
            }];

        case 'insert_page_break':
            return [{
                insertPageBreak: {
                    location: { index: op.index },
                }
            }];

        case 'create_bullet_list':
            return [{
                createParagraphBullets: {
                    range: { startIndex: op.startIndex, endIndex: op.endIndex },
                    bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
                }
            }];
    }
}

// --- Document Structure Parser ---

export interface DocStructureSummary {
    title: string;
    documentLength: number;
    paragraphCount: number;
    tableCount: number;
    sectionBreakCount: number;
    hasHeaders: boolean;
    hasFooters: boolean;
    tabs: { id: string; title: string; level: number }[];
    elements?: DocStructureElement[];
}

export interface DocStructureElement {
    type: 'paragraph' | 'table' | 'sectionBreak' | 'tableOfContents';
    startIndex: number;
    endIndex: number;
    textPreview?: string;
    tableRows?: number;
    tableColumns?: number;
    namedStyleType?: string;
}

/**
 * Parses a Google Doc into a structure summary.
 */
export function parseDocStructure(
    doc: docs_v1.Schema$Document,
    detailed: boolean,
    tabId?: string
): DocStructureSummary {
    const title = doc.title || 'Untitled';

    // Get tab info
    const allTabs = getAllTabs(doc);
    const tabs = allTabs.map(t => ({
        id: t.tabProperties?.tabId || '',
        title: t.tabProperties?.title || '',
        level: t.level,
    }));

    // Determine which content to analyze
    let body: docs_v1.Schema$Body | undefined;
    let headers: any = undefined;
    let footers: any = undefined;

    if (tabId && doc.tabs) {
        const tab = findTabById(doc, tabId);
        if (!tab) {
            throw new Error(`Tab not found: tabId "${tabId}" does not exist in this document.`);
        }
        if (tab.documentTab) {
            body = tab.documentTab.body;
            headers = tab.documentTab.headers;
            footers = tab.documentTab.footers;
        }
    } else if (doc.tabs && doc.tabs.length > 0) {
        // Default to first tab
        const firstTab = doc.tabs[0];
        if (firstTab?.documentTab) {
            body = firstTab.documentTab.body;
            headers = firstTab.documentTab.headers;
            footers = firstTab.documentTab.footers;
        }
    }

    // Fallback to legacy body field
    if (!body) {
        body = doc.body;
        headers = (doc as any).headers;
        footers = (doc as any).footers;
    }

    let paragraphCount = 0;
    let tableCount = 0;
    let sectionBreakCount = 0;
    let documentLength = 0;
    const elements: DocStructureElement[] = [];

    const content = body?.content || [];
    for (const el of content) {
        const startIdx = el.startIndex ?? 0;
        const endIdx = el.endIndex ?? 0;
        if (endIdx > documentLength) documentLength = endIdx;

        if (el.paragraph) {
            paragraphCount++;
            if (detailed) {
                let textPreview = '';
                for (const pe of el.paragraph.elements || []) {
                    if (pe.textRun?.content) {
                        textPreview += pe.textRun.content;
                    }
                }
                textPreview = textPreview.trim();
                if (textPreview.length > 100) {
                    textPreview = textPreview.substring(0, 100) + '...';
                }
                elements.push({
                    type: 'paragraph',
                    startIndex: startIdx,
                    endIndex: endIdx,
                    textPreview: textPreview || undefined,
                    namedStyleType: el.paragraph.paragraphStyle?.namedStyleType || undefined,
                });
            }
        } else if (el.table) {
            tableCount++;
            if (detailed) {
                const rows = el.table.tableRows?.length ?? 0;
                const columns = el.table.tableRows?.[0]?.tableCells?.length ?? 0;
                elements.push({
                    type: 'table',
                    startIndex: startIdx,
                    endIndex: endIdx,
                    tableRows: rows,
                    tableColumns: columns,
                });
            }
        } else if (el.sectionBreak) {
            sectionBreakCount++;
            if (detailed) {
                elements.push({
                    type: 'sectionBreak',
                    startIndex: startIdx,
                    endIndex: endIdx,
                });
            }
        } else if (el.tableOfContents) {
            if (detailed) {
                elements.push({
                    type: 'tableOfContents',
                    startIndex: startIdx,
                    endIndex: endIdx,
                });
            }
        }
    }

    const hasHeaders = headers ? Object.keys(headers).length > 0 : false;
    const hasFooters = footers ? Object.keys(footers).length > 0 : false;

    const summary: DocStructureSummary = {
        title,
        documentLength,
        paragraphCount,
        tableCount,
        sectionBreakCount,
        hasHeaders,
        hasFooters,
        tabs,
    };

    if (detailed) {
        summary.elements = elements;
    }

    return summary;
}
