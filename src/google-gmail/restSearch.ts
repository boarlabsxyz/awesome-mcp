// src/google-gmail/restSearch.ts
// GET /api/v1/gmail/messages — the REST sibling of searchEmails.
//
// The catalog documents ?q, but the route used to read only ?query, so a
// caller following the docs got recent mail, unfiltered, with a 200. ?q is
// now the parameter and ?query stays as an alias (the OpenAPI spec and the
// MCP tool both named it that). Anything else is refused by name: an ignored
// filter on a mail search returns the wrong mail with nothing to say so.

import type { gmail_v1 } from 'googleapis';

export const SEARCH_EMAILS_QUERY_PARAMS = ['q', 'query', 'maxResults', 'pageToken'] as const;

const ACCEPTED = 'Accepted: q (Gmail search, e.g. from:someone), query (alias of q), maxResults, pageToken.';

export interface SearchEmailsArgs {
  q: string;
  maxResults: number;
  pageToken?: string;
}

export type SearchEmailsParse =
  | { ok: true; args: SearchEmailsArgs }
  | { ok: false; error: string };

/** Read and check the query string; never guesses at a parameter it does not know. */
export function parseSearchEmailsQuery(query: Record<string, unknown>): SearchEmailsParse {
  const accepted: readonly string[] = SEARCH_EMAILS_QUERY_PARAMS;
  const unsupported = Object.keys(query).filter((k) => !accepted.includes(k));
  if (unsupported.length) {
    return { ok: false, error: `Unsupported query parameter(s): ${unsupported.join(', ')}. ${ACCEPTED}` };
  }
  // A repeated ?q=a&q=b arrives as an array and ?q[x]=y as an object. Reading
  // either as '' would search nothing and answer with recent mail.
  const notString = accepted.filter((k) => query[k] !== undefined && typeof query[k] !== 'string');
  if (notString.length) {
    return { ok: false, error: `Query parameter(s) given more than once or not as plain text: ${notString.join(', ')}. ${ACCEPTED}` };
  }
  const q = (query.q as string | undefined) ?? '';
  const alias = (query.query as string | undefined) ?? '';
  if (q && alias && q !== alias) {
    return { ok: false, error: `q and query are the same parameter and were given different values. Pass one. ${ACCEPTED}` };
  }
  return {
    ok: true,
    args: {
      q: q || alias,
      maxResults: parseInt(query.maxResults as string) || 10,
      pageToken: (query.pageToken as string | undefined) || undefined,
    },
  };
}

/** List matching messages and read each one's headers. Response shape is unchanged. */
export async function runSearchEmails(gmail: gmail_v1.Gmail, args: SearchEmailsArgs) {
  const listResult = await gmail.users.messages.list({
    userId: 'me', q: args.q, maxResults: args.maxResults, pageToken: args.pageToken,
  });
  const messages = [];
  for (const msg of listResult.data.messages || []) {
    const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Date'] });
    const headers = detail.data.payload?.headers || [];
    messages.push({
      id: msg.id, threadId: msg.threadId,
      subject: headers.find(h => h.name === 'Subject')?.value,
      from: headers.find(h => h.name === 'From')?.value,
      to: headers.find(h => h.name === 'To')?.value,
      date: headers.find(h => h.name === 'Date')?.value,
      labelIds: detail.data.labelIds,
      snippet: detail.data.snippet,
    });
  }
  return { messages, nextPageToken: listResult.data.nextPageToken };
}
