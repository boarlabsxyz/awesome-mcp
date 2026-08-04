// src/__tests__/hubspot/apiHelpers.test.ts
// Drives the HubSpotClient methods + formatters behind the four newly
// implemented tools against a mocked fetch, asserting they hit the official
// HubSpot REST endpoints and shape responses correctly.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HubSpotClient,
  hubspotSenderType,
  formatCompanyActivity,
  formatThreads,
  formatTickets,
} from '../../hubspot/apiHelpers.js';

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  json: () => Promise<any>;
  text: () => Promise<string>;
};

function jsonResponse(body: any, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  mock.restoreAll();
});

/** Install a fetch stub; returns the array of [url, init] calls it recorded. */
function stubFetch(handler: (url: string, init: any) => FakeResponse): Array<[string, any]> {
  const calls: Array<[string, any]> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push([String(url), init]);
    return handler(String(url), init) as unknown as Response;
  }) as typeof fetch;
  return calls;
}

test('getCompanyEngagementIds hits associations-v4 and extracts toObjectId', async () => {
  const calls = stubFetch(() => jsonResponse({ results: [{ toObjectId: 111 }, { toObjectId: 222 }, { id: 333 }] }));
  const client = new HubSpotClient('tok');
  const ids = await client.getCompanyEngagementIds('99');
  assert.deepEqual(ids, ['111', '222', '333']);
  assert.match(calls[0][0], /\/crm\/v4\/objects\/companies\/99\/associations\/engagements\?limit=500$/);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer tok');
});

test('getEngagementDetail hits legacy /engagements/v1', async () => {
  const calls = stubFetch(() => jsonResponse({ engagement: { id: 5, type: 'NOTE' }, metadata: { body: 'hi' } }));
  const client = new HubSpotClient('tok');
  const detail = await client.getEngagementDetail('5');
  assert.equal(detail.engagement?.type, 'NOTE');
  assert.match(calls[0][0], /\/engagements\/v1\/engagements\/5$/);
});

test('searchTickets retries on 429 then succeeds', async () => {
  let n = 0;
  const calls = stubFetch(() => {
    n += 1;
    return n === 1 ? jsonResponse({ message: 'rate limited' }, 429) : jsonResponse({ total: 1, results: [{ id: 't1' }] });
  });
  const client = new HubSpotClient('tok');
  const res = await client.searchTickets({ limit: 50 }, { maxRetries: 2, retryDelay: 0 });
  assert.equal(res.total, 1);
  assert.equal(calls.length, 2, 'should have retried once');
  assert.match(calls[0][0], /\/crm\/v3\/objects\/tickets\/search$/);
  assert.equal(calls[0][1].method, 'POST');
});

test('searchTickets gives up after maxRetries and throws with status', async () => {
  const calls = stubFetch(() => jsonResponse({ message: 'nope' }, 429));
  const client = new HubSpotClient('tok');
  await assert.rejects(
    () => client.searchTickets({ limit: 50 }, { maxRetries: 1, retryDelay: 0 }),
    (err: any) => err.status === 429,
  );
  assert.equal(calls.length, 2, 'initial attempt + 1 retry');
});

test('searchTickets does NOT retry on 400', async () => {
  const calls = stubFetch(() => jsonResponse({ message: 'bad' }, 400));
  const client = new HubSpotClient('tok');
  await assert.rejects(() => client.searchTickets({}, { maxRetries: 3, retryDelay: 0 }), (err: any) => err.status === 400);
  assert.equal(calls.length, 1, 'a 4xx that is not 429 must not retry');
});

test('listConversationThreads builds the paging query', async () => {
  const calls = stubFetch(() => jsonResponse({ results: [{ id: 'th1', status: 'OPEN' }], paging: { next: { after: 'NX' } } }));
  const client = new HubSpotClient('tok');
  const page = await client.listConversationThreads({ limit: 5, after: 'abc' });
  assert.equal(page.paging?.next?.after, 'NX');
  const url = calls[0][0];
  assert.match(url, /\/conversations\/v3\/conversations\/threads\?/);
  assert.match(url, /limit=5/);
  assert.match(url, /sort=-id/);
  assert.match(url, /after=abc/);
});

test('getThreadMessages and getTicketConversationIds hit the right endpoints', async () => {
  const calls = stubFetch((url) =>
    url.includes('/associations/conversation')
      ? jsonResponse({ results: [{ toObjectId: 'th9' }] })
      : jsonResponse({ results: [{ id: 'm1', type: 'MESSAGE', text: 'hello' }] }),
  );
  const client = new HubSpotClient('tok');
  const ids = await client.getTicketConversationIds('T1');
  assert.deepEqual(ids, ['th9']);
  assert.match(calls[0][0], /\/crm\/v4\/objects\/tickets\/T1\/associations\/conversation$/);
  const msgs = await client.getThreadMessages('th9');
  assert.equal(msgs.results?.[0]?.text, 'hello');
  assert.match(calls[1][0], /\/conversations\/v3\/conversations\/threads\/th9\/messages$/);
});

test('hubspotSenderType classifies agent vs customer vs unknown', () => {
  assert.equal(hubspotSenderType({ senders: [{ senderField: 'FROM', actorId: '0-1-42' }] }), 'AGENT');
  assert.equal(hubspotSenderType({ senders: [{ senderField: 'FROM', actorId: 'V-99' }] }), 'CUSTOMER');
  assert.equal(hubspotSenderType({ senders: [] }), 'UNKNOWN');
  assert.equal(hubspotSenderType({}), 'UNKNOWN');
});

test('formatCompanyActivity renders per-type content and notes omissions', () => {
  const out = formatCompanyActivity(
    [
      { engagement: { id: 1, type: 'NOTE', timestamp: 1700000000000 }, metadata: { body: 'a note' } },
      { engagement: { id: 2, type: 'EMAIL' }, metadata: { subject: 'Hi', from: { email: 'x@y.com' }, text: 'body' } },
    ],
    3,
  );
  assert.match(out, /Found 2 activities:/);
  assert.match(out, /NOTE \(id 1\)/);
  assert.match(out, /a note/);
  assert.match(out, /Subject: Hi/);
  assert.match(out, /\+3 more activities not shown/);
  assert.equal(formatCompanyActivity([]), 'No activity found for this company.');
});

test('formatThreads lists messages with sender labels and paging hint', () => {
  const out = formatThreads(
    [{ id: 'th1', status: 'OPEN', messages: [{ created_at: '2020', sender_type: 'AGENT', text: 'hello' }] }],
    'NEXT',
  );
  assert.match(out, /Found 1 conversation thread:/);
  assert.match(out, /Thread th1 \[OPEN\]/);
  assert.match(out, /AGENT: hello/);
  assert.match(out, /after="NEXT"/);
  assert.equal(formatThreads([]), 'No conversation threads found.');
});

test('formatTickets renders subject + total + pagination', () => {
  const out = formatTickets(
    [{ id: 't1', properties: { subject: 'Broken', hs_ticket_priority: 'HIGH', hs_pipeline_stage: '4' } }],
    7,
    'AFTER',
  );
  assert.match(out, /Found 1 of 7 tickets:/);
  assert.match(out, /Broken/);
  assert.match(out, /Priority: HIGH/);
  assert.match(out, /pagination token: AFTER/);
  assert.equal(formatTickets([]), 'No tickets found.');
});
