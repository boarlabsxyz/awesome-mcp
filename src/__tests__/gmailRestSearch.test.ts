// src/__tests__/gmailRestSearch.test.ts
// GET /api/v1/gmail/messages: the catalog documents ?q, the route used to read
// only ?query, and a caller following the docs got unfiltered mail with a 200.
// The 400 branch through Express is in restRoutes.googleWrites.test.ts; the
// success path is here, because gaxios does not use the global fetch.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { handleSearchEmailsRequest, parseSearchEmailsQuery, runSearchEmails, SEARCH_EMAILS_QUERY_PARAMS } from '../google-gmail/restSearch.js';
import { REST_CATALOG } from '../restCatalog.js';

function parsed(query: Record<string, unknown>) {
  const result = parseSearchEmailsQuery(query);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.args;
}

function refused(query: Record<string, unknown>): string {
  const result = parseSearchEmailsQuery(query);
  assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(query)}`);
  return (result as { error: string }).error;
}

describe('parseSearchEmailsQuery', () => {
  it('searches with the documented ?q', () => {
    assert.equal(parsed({ q: 'from:aliexpress' }).q, 'from:aliexpress');
  });

  it('keeps ?query as an alias for existing callers', () => {
    assert.equal(parsed({ query: 'in:inbox' }).q, 'in:inbox');
  });

  it('accepts q and query when they agree', () => {
    assert.equal(parsed({ q: 'is:unread', query: 'is:unread' }).q, 'is:unread');
  });

  it('refuses q and query that disagree rather than picking one', () => {
    assert.match(refused({ q: 'from:a', query: 'from:b' }), /different values/);
  });

  it('refuses an unknown parameter and names the accepted ones', () => {
    const error = refused({ search: 'from:aliexpress' });
    assert.match(error, /Unsupported query parameter\(s\): search\./);
    for (const name of SEARCH_EMAILS_QUERY_PARAMS) assert.ok(error.includes(name), `error should name ${name}: ${error}`);
  });

  it('refuses an unknown parameter even beside a valid search', () => {
    assert.match(refused({ q: 'from:a', labelIds: 'INBOX' }), /labelIds/);
  });

  it('refuses a repeated or nested q instead of searching for nothing', () => {
    assert.match(refused({ q: ['from:a', 'from:b'] }), /q/);
    assert.match(refused({ q: { x: 'y' } }), /q/);
    assert.match(refused({ maxResults: ['1', '2'] }), /maxResults/);
  });

  it('still lists recent mail when no search is given', () => {
    assert.deepEqual(parsed({}), { q: '', maxResults: 10, pageToken: undefined });
  });

  it('keeps maxResults and pageToken as before', () => {
    assert.deepEqual(parsed({ q: 'x', maxResults: '3', pageToken: 'tok' }), { q: 'x', maxResults: 3, pageToken: 'tok' });
    assert.equal(parsed({ maxResults: 'lots' }).maxResults, 10);
  });

  it('accepts the parameter the catalog documents', () => {
    const entry = REST_CATALOG.find((e) => e.mcpToolName === 'searchEmails' && e.method === 'GET');
    assert.ok(entry);
    const documented = [...entry.path.matchAll(/[?&]([A-Za-z_]+)=\{/g)].map(([, name]) => name);
    assert.deepEqual(documented, ['q']);
    for (const name of documented) assert.ok((SEARCH_EMAILS_QUERY_PARAMS as readonly string[]).includes(name), name);
  });
});

describe('runSearchEmails', () => {
  it('sends q to Gmail and answers with only the messages Gmail matched', async () => {
    const list = mock.fn(async (_params: unknown) => ({ data: { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'next' } }));
    const get = mock.fn(async () => ({
      data: {
        labelIds: ['INBOX'],
        snippet: 'Your order',
        payload: { headers: [{ name: 'Subject', value: 'Order shipped' }, { name: 'From', value: 'AliExpress <a@aliexpress.com>' }] },
      },
    }));
    const gmail = { users: { messages: { list, get } } } as any;

    const result = await runSearchEmails(gmail, parsed({ q: 'from:aliexpress', maxResults: '3', pageToken: 'page2' }));

    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[0].arguments[0], { userId: 'me', q: 'from:aliexpress', maxResults: 3, pageToken: 'page2' });
    assert.equal(get.mock.callCount(), 1);
    assert.equal(result.nextPageToken, 'next');
    assert.deepEqual(result.messages.map((m) => [m.id, m.from, m.subject]), [['m1', 'AliExpress <a@aliexpress.com>', 'Order shipped']]);
  });

  it('answers an empty list when nothing matches', async () => {
    const gmail = { users: { messages: { list: mock.fn(async () => ({ data: {} })), get: mock.fn() } } } as any;
    assert.deepEqual(await runSearchEmails(gmail, parsed({ q: 'from:nobody' })), { messages: [], nextPageToken: undefined });
  });
});

describe('handleSearchEmailsRequest', () => {
  function fakeGmail() {
    const list = mock.fn(async (_params: unknown) => ({ data: { messages: [{ id: 'm1', threadId: 't1' }] } }));
    const get = mock.fn(async () => ({ data: { payload: { headers: [{ name: 'From', value: 'a@aliexpress.com' }] } } }));
    return { list, get, gmail: { users: { messages: { list, get } } } as any };
  }

  it('searches Gmail with the q from the query string', async () => {
    const { list, gmail } = fakeGmail();
    const res = await handleSearchEmailsRequest({ q: 'from:aliexpress' }, gmail);
    assert.equal(res.status, 200);
    assert.equal((list.mock.calls[0].arguments[0] as { q: string }).q, 'from:aliexpress');
    assert.deepEqual((res.body as { messages: Array<{ id: string }> }).messages.map((m) => m.id), ['m1']);
  });

  it('answers 400 and never calls Gmail for a parameter it does not read', async () => {
    const { list, gmail } = fakeGmail();
    const res = await handleSearchEmailsRequest({ search: 'from:aliexpress' }, gmail);
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /search/);
    assert.equal(list.mock.callCount(), 0);
  });
});
