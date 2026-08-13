// src/__tests__/hubspot/serverOps.test.ts
// Drives every HubSpot tool operation (the exported op* functions in
// server.ts) against a mocked fetch, asserting request shape and output.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubSpotClient } from '../../hubspot/apiHelpers.js';
import {
  opCreateCompany,
  opGetActiveCompanies,
  opSearchCompanies,
  opGetCompany,
  opUpdateCompany,
  opGetCompanyActivity,
  opCreateContact,
  opGetActiveContacts,
  opSearchContacts,
  opGetContact,
  opUpdateContact,
  opGetActiveDeals,
  opGetDeal,
  opCreateDeal,
  opUpdateDeal,
  opListPipelines,
  opGetRecentConversations,
  opGetTickets,
  opGetTicketConversationThreads,
  opGetProperty,
  opUpdateProperty,
  opCreateProperty,
} from '../../hubspot/server.js';

type Rt = { status?: number; body?: any };
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; mock.restoreAll(); });

/** Route fetch by (method, url) → response; record calls for assertions. */
function router(handler: (method: string, url: string, body: any) => Rt): Array<{ method: string; url: string; body: any }> {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const { status = 200, body: rb = {} } = handler(method, String(url), body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => rb,
      text: async () => JSON.stringify(rb),
    } as any as Response;
  }) as typeof fetch;
  return calls;
}

const client = () => new HubSpotClient('tok');

test('opCreateCompany dedupes, and canonical name overrides a stray properties.name', async () => {
  // Dedup hit
  let calls = router(() => ({ body: { total: 1, results: [{ id: 'c9', properties: { name: 'Acme' } }] } }));
  assert.match(await opCreateCompany(client(), { name: 'Acme' }), /already exists/);
  assert.equal(calls.length, 1);

  // Create path — properties.name must NOT win over args.name
  calls = router((method, url) => (url.endsWith('/search') ? { body: { total: 0 } } : { body: { id: 'c1', properties: { name: 'Acme' } } }));
  const out = await opCreateCompany(client(), { name: 'Acme', properties: { name: 'WRONG', domain: 'acme.com' } });
  assert.match(out, /Created company/);
  const createCall = calls.find(c => c.method === 'POST' && !c.url.endsWith('/search'))!;
  assert.equal(createCall.body.properties.name, 'Acme');
  assert.equal(createCall.body.properties.domain, 'acme.com');
});

test('opGetActiveCompanies / opGetActiveContacts format the search results', async () => {
  router(() => ({ body: { results: [{ id: 'c1', properties: { name: 'Acme' } }] } }));
  assert.match(await opGetActiveCompanies(client(), { limit: 10 }), /Found 1 companies:/);
  router(() => ({ body: { results: [{ id: 'p1', properties: { email: 'a@b.com' } }] } }));
  assert.match(await opGetActiveContacts(client(), { limit: 10 }), /Found 1 contacts:/);
});

test('opSearchCompanies sends query + filters and surfaces requested properties', async () => {
  const calls = router(() => ({ body: { results: [{ id: 'c1', properties: { name: 'Stagen', domain: 'stagen.com' } }] } }));
  const out = await opSearchCompanies(client(), {
    query: 'Stagen',
    filters: [{ propertyName: 'industry', operator: 'EQ', value: 'Consulting' }],
    limit: 10,
  });
  assert.match(out, /Found 1 companies:/);
  assert.match(out, /ID: c1/);
  assert.match(out, /domain: stagen\.com/, 'requested/default properties are surfaced in search results');
  // Search hits the object search endpoint with the free-text query and an AND filter group.
  const searchCall = calls.find(c => c.url.endsWith('/companies/search'))!;
  assert.equal(searchCall.method, 'POST');
  assert.equal(searchCall.body.query, 'Stagen');
  assert.equal(searchCall.body.filterGroups[0].filters[0].propertyName, 'industry');
  assert.equal(searchCall.body.limit, 10);
});

test('opSearchContacts sends a filters-only search (no free-text query)', async () => {
  const calls = router(() => ({ body: { results: [{ id: 'p1', properties: { email: 'ada@x.com' } }] } }));
  const out = await opSearchContacts(client(), {
    filters: [{ propertyName: 'email', operator: 'EQ', value: 'ada@x.com' }],
    limit: 5,
  });
  assert.match(out, /Found 1 contacts:/);
  const searchCall = calls.find(c => c.url.endsWith('/contacts/search'))!;
  assert.equal(searchCall.body.query, undefined, 'no query key when only filters are given');
  assert.equal(searchCall.body.filterGroups[0].filters[0].value, 'ada@x.com');
});

test('opGetCompany flags unknown requested properties (reads are loud)', async () => {
  router(() => ({ body: { id: 'c1', properties: { name: 'Acme' } } }));
  const got = await opGetCompany(client(), { companyId: 'c1', properties: ['name', 'totally_fake_property_xyz'] });
  assert.match(got, /Company:/);
  assert.match(got, /not returned.*totally_fake_property_xyz/i);
  // no note when nothing was explicitly requested
  router(() => ({ body: { id: 'c1', properties: { name: 'Acme' } } }));
  assert.doesNotMatch(await opGetCompany(client(), { companyId: 'c1' }), /not returned/i);
});

test('opUpdateCompany re-reads for a consistent read shape (PATCH then GET)', async () => {
  const calls = router(() => ({ body: { id: 'c1', properties: { name: 'New' } } }));
  assert.match(await opUpdateCompany(client(), { companyId: 'c1', properties: { name: 'New' } }), /Updated company/);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[1].method, 'GET', 'update must re-read the record');
});

test('opGetCompanyActivity fans out to engagement details and reports omissions', async () => {
  const ids = Array.from({ length: 102 }, (_, i) => ({ toObjectId: i }));
  const calls = router((method, url) =>
    url.includes('/associations/engagements')
      ? { body: { results: ids } }
      : { body: { engagement: { id: 1, type: 'NOTE', timestamp: 1786187594925 }, metadata: { body: 'note body' } } },
  );
  const out = await opGetCompanyActivity(client(), { companyId: 'c1' });
  assert.match(out, /Found 100 activities:/);          // capped at MAX_ACTIVITY_FETCH
  assert.match(out, /\+2 more activities not shown/);
  // epoch millis rendered as ISO-8601, not raw (P1 fix)
  assert.match(out, /When: 20\d\d-\d\d-\d\dT/);
  assert.doesNotMatch(out, /1786187594925/);
  // 1 association call + 100 detail calls
  assert.equal(calls.filter(c => c.url.includes('/engagements/v1/')).length, 100);
});

test('opCreateContact dedupes (with company filter) and enforces canonical fields', async () => {
  let calls = router(() => ({ body: { total: 1, results: [{ id: 'p9', properties: {} }] } }));
  assert.match(await opCreateContact(client(), { firstname: 'Ada', lastname: 'L', properties: { company: 'Acme' } }), /already exists/);
  // search body includes the company filter
  assert.equal(calls[0].body.filterGroups[0].filters.length, 3);

  calls = router((method, url) => (url.endsWith('/search') ? { body: { total: 0 } } : { body: { id: 'p1', properties: {} } }));
  await opCreateContact(client(), { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@x.com', properties: { firstname: 'WRONG' } });
  const createCall = calls.find(c => c.method === 'POST' && !c.url.endsWith('/search'))!;
  assert.equal(createCall.body.properties.firstname, 'Ada');
  assert.equal(createCall.body.properties.email, 'ada@x.com');
});

test('opGetContact; opUpdateContact re-reads (PATCH then GET)', async () => {
  router(() => ({ body: { id: 'p1', properties: { email: 'a@b.com' } } }));
  assert.match(await opGetContact(client(), { contactId: 'p1' }), /Contact:/);
  const calls = router(() => ({ body: { id: 'p1', properties: { firstname: 'Ada', email: 'z@z.com' } } }));
  const out = await opUpdateContact(client(), { contactId: 'p1', properties: { email: 'z@z.com' } });
  assert.match(out, /Updated contact/);
  assert.match(out, /firstname: Ada/, 're-read surfaces populated fields the PATCH echo omits');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[1].method, 'GET');
});

test('opGetActiveDeals lists deals by dealname and surfaces amount/stage', async () => {
  router(() => ({ body: { results: [{ id: 'd1', properties: { dealname: 'Big Deal', amount: '5000', dealstage: 'contractsent' } }] } }));
  const out = await opGetActiveDeals(client(), { limit: 10 });
  assert.match(out, /Found 1 deals:/);
  assert.match(out, /Big Deal/, 'deal name resolves from dealname');
  assert.match(out, /amount: 5000/);
});

test('opGetDeal renders a deal and flags unknown requested properties', async () => {
  router(() => ({ body: { id: 'd1', properties: { dealname: 'Big Deal' } } }));
  const out = await opGetDeal(client(), { dealId: 'd1', properties: ['dealname', 'nope_xyz'] });
  assert.match(out, /Deal:/);
  assert.match(out, /not returned.*nope_xyz/i);
});

test('opCreateDeal creates without dedupe; canonical dealname wins', async () => {
  const calls = router(() => ({ body: { id: 'd1', properties: { dealname: 'Big Deal' } } }));
  await opCreateDeal(client(), { dealname: 'Big Deal', properties: { dealname: 'WRONG', amount: '10' } });
  // No search/dedupe call — first request is the POST create.
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.endsWith('/deals'), true);
  assert.equal(calls[0].body.properties.dealname, 'Big Deal');
  assert.equal(calls[0].body.properties.amount, '10');
});

test('opUpdateDeal re-reads for a consistent read shape (PATCH then GET)', async () => {
  const calls = router(() => ({ body: { id: 'd1', properties: { dealname: 'Renamed' } } }));
  assert.match(await opUpdateDeal(client(), { dealId: 'd1', properties: { dealname: 'Renamed' } }), /Updated deal/);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[1].method, 'GET', 'update must re-read the record');
});

test('opListPipelines renders pipelines with stages ordered by displayOrder', async () => {
  const calls = router(() => ({ body: { results: [
    { id: 'default', label: 'Sales Pipeline', stages: [
      { id: 's2', label: 'Closed Won', displayOrder: 1 },
      { id: 's1', label: 'Appointment', displayOrder: 0 },
    ] },
  ] } }));
  const out = await opListPipelines(client(), {});
  assert.match(out, /Sales Pipeline \(id default\)/);
  // Stage with displayOrder 0 must precede displayOrder 1 in the output.
  assert.ok(out.indexOf('Appointment') < out.indexOf('Closed Won'), 'stages sorted by displayOrder');
  assert.equal(calls[0].url.endsWith('/crm/v3/pipelines/deals'), true);
});

test('opGetRecentConversations renders threads with their MESSAGE entries', async () => {
  const calls = router((method, url) =>
    url.includes('/threads/') && url.endsWith('/messages')
      ? { body: { results: [
          { id: 'm1', type: 'MESSAGE', text: 'hello', createdAt: '2020-01-01', senders: [{ senderField: 'FROM', actorId: '0-1-x' }] },
          { id: 'sys', type: 'SYSTEM', text: 'ignored' },
        ] } }
      : { body: { results: [{ id: 'th1', status: 'OPEN' }], paging: { next: { after: 'NX' } } } },
  );
  const out = await opGetRecentConversations(client(), { limit: 10 });
  assert.match(out, /Thread th1 \[OPEN\]/);
  assert.match(out, /AGENT: hello/);
  assert.doesNotMatch(out, /ignored/);
  assert.match(out, /after="NX"/);
  assert.ok(calls.some(c => c.url.includes('/conversations/v3/conversations/threads?')));
});

test('opGetTickets builds default vs Closed filter groups', async () => {
  const NOW = Date.UTC(2026, 0, 2, 0, 0, 0); // deterministic
  let calls = router(() => ({ body: { total: 0, results: [] } }));
  await opGetTickets(client(), { criteria: 'default', limit: 50, maxRetries: 0, retryDelay: 0 }, NOW);
  let fg = calls[0].body.filterGroups;
  assert.equal(fg[0].filters[0].propertyName, 'closedate');
  assert.equal(fg[0].filters[0].operator, 'GT');
  // HubSpot search wants epoch millis for datetime props, not ISO (P0 fix).
  assert.equal(fg[0].filters[0].value, String(NOW - 24 * 60 * 60 * 1000));
  assert.match(fg[0].filters[0].value, /^\d+$/);
  assert.equal(fg[1].filters[0].propertyName, 'hs_lastmodifieddate');

  calls = router(() => ({ body: { total: 1, results: [{ id: 't1', properties: { subject: 'X' } }] } }));
  const out = await opGetTickets(client(), { criteria: 'Closed', limit: 50, maxRetries: 0, retryDelay: 0 }, NOW);
  fg = calls[0].body.filterGroups;
  assert.equal(fg[0].filters[0].propertyName, 'hs_pipeline_stage');
  assert.equal(fg[0].filters[0].value, '4');
  assert.match(out, /Found 1 of 1 tickets:/);
});

test('opGetTicketConversationThreads aggregates thread messages', async () => {
  router((method, url) =>
    url.includes('/associations/conversation')
      ? { body: { results: [{ toObjectId: 'th1' }] } }
      : { body: { results: [{ id: 'm1', type: 'MESSAGE', text: 'hi', createdAt: '2020' }] } },
  );
  const out = await opGetTicketConversationThreads(client(), { ticketId: 'T1' });
  assert.match(out, /Thread th1/);
  assert.match(out, /hi/);
});

test('property ops send the right bodies', async () => {
  let calls = router(() => ({ body: { name: 'industry', label: 'Industry', type: 'string', fieldType: 'text' } }));
  assert.match(await opGetProperty(client(), { objectType: 'companies', propertyName: 'industry' }), /Property: Industry/);
  assert.match(calls[0].url, /\/crm\/v3\/properties\/companies\/industry$/);

  calls = router(() => ({ body: { name: 'stage', label: 'Stage', options: [{ label: 'New', value: 'new' }] } }));
  await opUpdateProperty(client(), { objectType: 'contacts', propertyName: 'stage', options: [{ label: 'New', value: 'new' }], label: 'Stage' });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].body.label, 'Stage');
  assert.equal(calls[0].body.options.length, 1);

  calls = router(() => ({ body: { name: 'p', label: 'P' } }));
  await opCreateProperty(client(), { objectType: 'companies', name: 'p', label: 'P', type: 'string', fieldType: 'text', groupName: 'g', description: 'd' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.groupName, 'g');
  assert.equal(calls[0].body.description, 'd');
});
