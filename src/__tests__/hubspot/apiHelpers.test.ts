// src/__tests__/hubspot/apiHelpers.test.ts
// Drives the HubSpotClient methods + formatters behind the four newly
// implemented tools against a mocked fetch, asserting they hit the official
// HubSpot REST endpoints and shape responses correctly.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import {
  HubSpotClient,
  hubspotSenderType,
  formatCompanyActivity,
  formatThreads,
  formatTickets,
  formatCompany,
  formatContact,
  formatDeal,
  formatEngagement,
  formatObjectList,
  formatPipelines,
  formatProperty,
  recentCompaniesSearch,
  recentContactsSearch,
  recentDealsSearch,
  eqFilterGroup,
  textSearch,
  getHubSpotClient,
  mapHubSpotError,
  withHubSpotClient,
  maybeRefreshHubSpotToken,
  epochToIso,
  missingPropertiesNote,
} from '../../hubspot/apiHelpers.js';

const noopLog = { info: () => {}, error: () => {} };

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

// --- CRUD client methods: correct verb, path, and body ---

test('company CRUD methods hit the right endpoints', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'c1', properties: { name: 'Acme' } }));
  const client = new HubSpotClient('tok');

  await client.searchCompanies({ q: 1 });
  assert.match(calls[0][0], /\/crm\/v3\/objects\/companies\/search$/);
  assert.equal(calls[0][1].method, 'POST');

  await client.createCompany({ name: 'Acme' });
  assert.match(calls[1][0], /\/crm\/v3\/objects\/companies$/);
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body), { properties: { name: 'Acme' } });

  await client.getCompany('c1', ['name', 'domain']);
  assert.match(calls[2][0], /\/crm\/v3\/objects\/companies\/c1\?archived=false&properties=name,domain$/);
  assert.equal(calls[2][1].method, 'GET');

  await client.updateCompany('c1', { name: 'New' });
  assert.match(calls[3][0], /\/crm\/v3\/objects\/companies\/c1$/);
  assert.equal(calls[3][1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[3][1].body), { properties: { name: 'New' } });
});

test('getCompany omits the properties query when none requested', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'c1' }));
  await new HubSpotClient('tok').getCompany('c1');
  assert.match(calls[0][0], /\/crm\/v3\/objects\/companies\/c1\?archived=false$/);
});

test('contact CRUD methods hit the right endpoints', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'p1', properties: {} }));
  const client = new HubSpotClient('tok');

  await client.searchContacts({ q: 1 });
  assert.match(calls[0][0], /\/crm\/v3\/objects\/contacts\/search$/);

  await client.createContact({ firstname: 'A' });
  assert.match(calls[1][0], /\/crm\/v3\/objects\/contacts$/);
  assert.deepEqual(JSON.parse(calls[1][1].body), { properties: { firstname: 'A' } });

  await client.getContact('p1');
  assert.match(calls[2][0], /\/crm\/v3\/objects\/contacts\/p1\?archived=false$/);

  await client.updateContact('p1', { email: 'x@y.com' });
  assert.match(calls[3][0], /\/crm\/v3\/objects\/contacts\/p1$/);
  assert.equal(calls[3][1].method, 'PATCH');
});

test('deal CRUD + pipeline methods hit the right endpoints', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'd1', properties: { dealname: 'Big' } }));
  const client = new HubSpotClient('tok');

  await client.searchDeals({ q: 1 });
  assert.match(calls[0][0], /\/crm\/v3\/objects\/deals\/search$/);
  assert.equal(calls[0][1].method, 'POST');

  await client.createDeal({ dealname: 'Big' });
  assert.match(calls[1][0], /\/crm\/v3\/objects\/deals$/);
  assert.deepEqual(JSON.parse(calls[1][1].body), { properties: { dealname: 'Big' } });

  await client.getDeal('d1', ['dealname', 'amount']);
  assert.match(calls[2][0], /\/crm\/v3\/objects\/deals\/d1\?archived=false&properties=dealname,amount$/);

  await client.updateDeal('d1', { amount: '99' });
  assert.match(calls[3][0], /\/crm\/v3\/objects\/deals\/d1$/);
  assert.equal(calls[3][1].method, 'PATCH');

  await client.listDealPipelines();
  assert.match(calls[4][0], /\/crm\/v3\/pipelines\/deals$/);
  assert.equal(calls[4][1].method, 'GET');
});

test('recentDealsSearch sorts by last-modified; getProperty accepts deals', async () => {
  const de = recentDealsSearch(7) as any;
  assert.equal(de.limit, 7);
  assert.equal(de.sorts[0].propertyName, 'hs_lastmodifieddate');
  assert.ok(de.properties.includes('dealname'));

  const calls = stubFetch(() => jsonResponse({ name: 'dealstage', label: 'Deal Stage' }));
  await new HubSpotClient('tok').getProperty('deals', 'dealstage');
  assert.match(calls[0][0], /\/crm\/v3\/properties\/deals\/dealstage$/);
});

test('engagement methods hit the right endpoints (create + v4 default association)', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'n1', properties: {} }));
  const client = new HubSpotClient('tok');

  await client.createEngagement('notes', { hs_note_body: 'hi', hs_timestamp: 1 });
  assert.match(calls[0][0], /\/crm\/v3\/objects\/notes$/);
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { properties: { hs_note_body: 'hi', hs_timestamp: 1 } });

  await client.associateDefault('notes', 'n1', 'companies', '7488047372');
  assert.match(calls[1][0], /\/crm\/v4\/objects\/notes\/n1\/associations\/default\/companies\/7488047372$/);
  assert.equal(calls[1][1].method, 'PUT');
  assert.equal(calls[1][1].body, undefined, 'default association PUT sends no body');
});

test('formatEngagement labels the object per activity type', () => {
  assert.match(formatEngagement({ id: 'n1', properties: { hs_note_body: 'hi' } }, 'note'), /note:/);
});

test('formatDeal + formatPipelines render deal object and pipeline stages', () => {
  assert.match(formatDeal({ id: 'd1', properties: { dealname: 'Big' } }), /Deal:/);
  assert.equal(formatPipelines([]), 'No deal pipelines found.');
  const out = formatPipelines([
    { id: 'default', label: 'Sales', stages: [{ id: 's1', label: 'New', displayOrder: 0 }] },
  ]);
  assert.match(out, /Sales \(id default\)/);
  assert.match(out, /- New \(id s1\)/);
});

test('property methods hit the right endpoints', async () => {
  const calls = stubFetch(() => jsonResponse({ name: 'p', label: 'P' }));
  const client = new HubSpotClient('tok');

  await client.getProperty('companies', 'industry');
  assert.match(calls[0][0], /\/crm\/v3\/properties\/companies\/industry$/);

  await client.updateProperty('contacts', 'lifecyclestage', { options: [] });
  assert.match(calls[1][0], /\/crm\/v3\/properties\/contacts\/lifecyclestage$/);
  assert.equal(calls[1][1].method, 'PATCH');

  await client.createProperty('companies', { name: 'x' });
  assert.match(calls[2][0], /\/crm\/v3\/properties\/companies$/);
  assert.equal(calls[2][1].method, 'POST');
});

test('non-2xx CRUD response throws an error carrying the status', async () => {
  stubFetch(() => jsonResponse({ message: 'bad' }, 404));
  await assert.rejects(() => new HubSpotClient('tok').getCompany('missing'), (err: any) => err.status === 404);
});

// --- Search-request builders ---

test('recentCompaniesSearch / recentContactsSearch sort by last-modified', () => {
  const co = recentCompaniesSearch(5) as any;
  assert.equal(co.limit, 5);
  assert.equal(co.sorts[0].propertyName, 'hs_lastmodifieddate');
  assert.equal(co.sorts[0].direction, 'DESCENDING');

  const ct = recentContactsSearch(3) as any;
  assert.equal(ct.limit, 3);
  assert.equal(ct.sorts[0].propertyName, 'lastmodifieddate');
});

test('eqFilterGroup builds an EQ filter group', () => {
  const fg = eqFilterGroup([{ propertyName: 'name', value: 'Acme' }]) as any;
  assert.deepEqual(fg, { filterGroups: [{ filters: [{ propertyName: 'name', value: 'Acme', operator: 'EQ' }] }] });
});

test('textSearch maps query + filters into a search body, omitting empty parts', () => {
  const full = textSearch({
    query: 'Acme',
    filters: [{ propertyName: 'domain', operator: 'EQ', value: 'acme.com' }],
    properties: ['name', 'domain'],
    limit: 25,
  }) as any;
  assert.equal(full.query, 'Acme');
  assert.equal(full.limit, 25);
  assert.deepEqual(full.properties, ['name', 'domain']);
  assert.deepEqual(full.filterGroups, [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: 'acme.com' }] }]);

  // Query omitted when empty; filterGroups omitted when there are no filters.
  const queryOnly = textSearch({ query: 'Acme', properties: ['name'], limit: 10 }) as any;
  assert.equal('filterGroups' in queryOnly, false);
  const filtersEmpty = textSearch({ properties: ['name'], limit: 10 }) as any;
  assert.equal('query' in filtersEmpty, false);
  assert.equal('filterGroups' in filtersEmpty, false);
});

// --- CRUD formatters ---

test('formatCompany / formatContact render id + properties', () => {
  const co = formatCompany({ id: 'c1', properties: { name: 'Acme', domain: 'acme.com', blank: '' }, updatedAt: '2020' });
  assert.match(co, /Company:/);
  assert.match(co, /ID: c1/);
  assert.match(co, /name: Acme/);
  assert.match(co, /domain: acme.com/);
  assert.doesNotMatch(co, /blank:/, 'empty values are skipped');
  assert.equal(formatCompany(undefined), 'No Company data returned.');

  assert.match(formatContact({ id: 'p1', properties: { email: 'a@b.com' } }), /Contact:/);
});

test('formatObjectList counts and labels entries by name/email/fallback', () => {
  const out = formatObjectList(
    [
      { id: 'c1', properties: { name: 'Acme' } },
      { id: 'p1', properties: { firstname: 'Ada', lastname: 'Lovelace' } },
      { id: 'p2', properties: { email: 'x@y.com' } },
      { id: 'p3', properties: {} },
    ],
    'records',
  );
  assert.match(out, /Found 4 records:/);
  assert.match(out, /Acme/);
  assert.match(out, /Ada Lovelace/);
  assert.match(out, /x@y.com/);
  assert.match(out, /\(unnamed\)/);
  assert.equal(formatObjectList([], 'records'), 'No records found.');
});

test('formatObjectList distinguishes empty properties from ones HubSpot never returned', () => {
  const out = formatObjectList(
    // HubSpot echoes requested properties with null when unset, and simply
    // omits keys it does not recognise.
    [{ id: 'c1', properties: { name: 'Stagen', domain: 'stagen.com', city: null, country: '' } }],
    'companies',
    ['name', 'domain', 'city', 'country', 'totally_fake_property_xyz'],
  );
  assert.match(out, /domain: stagen\.com/);
  assert.match(out, /city: \(empty\)/, 'a property that is unset on the record is rendered, not dropped');
  assert.match(out, /country: \(empty\)/, 'empty string counts as unset');
  assert.doesNotMatch(out, /totally_fake_property_xyz: /, 'an unreturned property gets no value line');
  assert.match(
    out,
    /⚠ Requested properties not returned by HubSpot \(unknown or unavailable\): totally_fake_property_xyz/,
    'unknown properties are called out instead of looking like empty ones',
  );
});

test('epochToIso normalizes epoch millis (number or numeric string) to ISO, passes others through', () => {
  assert.equal(epochToIso(1786187594925), new Date(1786187594925).toISOString());
  assert.equal(epochToIso('1786187594925'), new Date(1786187594925).toISOString());
  assert.equal(epochToIso(''), '');
  assert.equal(epochToIso(undefined), '');
  assert.equal(epochToIso('2020-01-01T00:00:00Z'), '2020-01-01T00:00:00Z'); // already ISO → unchanged
});

test('missingPropertiesNote flags requested-but-absent keys only', () => {
  const obj = { id: 'c1', properties: { name: 'Acme', domain: '' } };
  assert.equal(missingPropertiesNote(undefined, obj), '');           // nothing requested
  assert.equal(missingPropertiesNote(['name', 'domain'], obj), '');  // present (domain empty but present)
  assert.match(missingPropertiesNote(['name', 'bogus'], obj), /not returned.*bogus/i);
});

test('formatProperty renders definition + options', () => {
  const out = formatProperty({
    name: 'stage', label: 'Stage', type: 'enumeration', fieldType: 'select', groupName: 'g',
    description: 'the stage', options: [{ label: 'New', value: 'new' }],
  });
  assert.match(out, /Property: Stage/);
  assert.match(out, /Type: enumeration/);
  assert.match(out, /Options \(1\)/);
  assert.match(out, /New = new/);
  assert.equal(formatProperty(undefined), 'No property data returned.');
});

// --- session + error helpers ---

test('getHubSpotClient throws when not connected, builds a client when connected', () => {
  assert.throws(() => getHubSpotClient(undefined), UserError);
  assert.throws(() => getHubSpotClient({} as any), /not connected/i);
  const client = getHubSpotClient({ hubspotAccessToken: 'tok', hubspotBaseUrl: 'https://eu.hubapi.com/' } as any);
  assert.equal(client.baseUrl, 'https://eu.hubapi.com');
});

test('mapHubSpotError maps status codes to friendly UserErrors', () => {
  assert.throws(() => mapHubSpotError('Op', { status: 401 }, noopLog), /not authorized/i);
  assert.throws(() => mapHubSpotError('Op', { status: 403 }, noopLog), /not authorized/i);
  assert.throws(() => mapHubSpotError('Op', { status: 404 }, noopLog), /not found/i);
  assert.throws(() => mapHubSpotError('Op', { message: 'weird' }, noopLog), /Op: weird/);
});

test('withHubSpotClient returns fn result on success', async () => {
  const out = await withHubSpotClient('Op', { hubspotAccessToken: 'tok' } as any, noopLog, async (c) => {
    assert.ok(c instanceof HubSpotClient);
    return 'ok';
  });
  assert.equal(out, 'ok');
});

test('withHubSpotClient maps a thrown API error, but surfaces not-connected verbatim', async () => {
  await assert.rejects(
    () => withHubSpotClient('Op', { hubspotAccessToken: 'tok' } as any, noopLog, async () => { throw { status: 404 }; }),
    /Op: not found/i,
  );
  await assert.rejects(
    () => withHubSpotClient('Op', undefined, noopLog, async () => 'never'),
    /not connected/i,
  );
});

// --- OAuth token refresh (maybeRefreshHubSpotToken) ---

test('maybeRefreshHubSpotToken is a no-op for paste-token sessions', async () => {
  const calls = stubFetch(() => jsonResponse({}));
  const session: any = { hubspotAccessToken: 'AT' }; // no expiry / refresh / creds
  await maybeRefreshHubSpotToken(session, noopLog);
  assert.equal(session.hubspotAccessToken, 'AT');
  assert.equal(calls.length, 0, 'must not hit the token endpoint');
});

test('maybeRefreshHubSpotToken refreshes an expiring OAuth token in place', async () => {
  const calls = stubFetch(() => jsonResponse({ access_token: 'NEW', expires_in: 1800 }));
  const session: any = {
    hubspotAccessToken: 'OLD',
    hubspotTokenExpiry: Date.now() - 1000, // already expired
    hubspotRefreshToken: 'RT',
    hubspotOauthClientId: 'cid',
    hubspotOauthClientSecret: 'sec',
    // no hubspotInstanceId → skip the DB persist branch
  };
  await maybeRefreshHubSpotToken(session, noopLog);
  assert.equal(session.hubspotAccessToken, 'NEW');
  assert.equal(session.hubspotRefreshToken, 'RT', 'HubSpot does not rotate — keep the old refresh token');
  assert.ok(session.hubspotTokenExpiry > Date.now(), 'expiry pushed into the future');
  assert.match(calls[0][0], /\/oauth\/v1\/token$/);
});

test('maybeRefreshHubSpotToken skips refresh when the token is still fresh', async () => {
  const calls = stubFetch(() => jsonResponse({ access_token: 'NEW' }));
  const session: any = {
    hubspotAccessToken: 'OLD',
    hubspotTokenExpiry: Date.now() + 3_600_000, // an hour out
    hubspotRefreshToken: 'RT',
    hubspotOauthClientId: 'cid',
    hubspotOauthClientSecret: 'sec',
  };
  await maybeRefreshHubSpotToken(session, noopLog);
  assert.equal(session.hubspotAccessToken, 'OLD');
  assert.equal(calls.length, 0);
});
