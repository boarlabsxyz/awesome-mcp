import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubSpotClient } from '../../hubspot/apiHelpers.js';
import {
  opLogEmail,
  performUpdateEngagement,
  performCreateTicket,
  fetchTicketsSearch,
  searchTicketsSchema,
  performCreatePipeline,
  performUpdatePipelineStage,
  createPipelineSchema,
  deleteEngagementRestSchema,
  deleteEngagementSchema,
  opListPipelines,
} from '../../hubspot/server.js';

// What these assert is the request that reaches HubSpot (path, method, body)
// and how an unconfirmed write is reported.

type Rt = { status?: number; body?: any };
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function router(handler: (method: string, url: string, body: any) => Rt) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const { status = 200, body: rb = {} } = handler(method, String(url), body);
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => rb, text: async () => JSON.stringify(rb),
    } as any as Response;
  }) as typeof fetch;
  return calls;
}
const client = () => new HubSpotClient('tok');

test('logEmail creates an email engagement (direction defaults to EMAIL) and can attach it to a ticket', async () => {
  const calls = router((method) => (method === 'POST' ? { body: { id: 'e1', properties: {} } } : { body: {} }));
  const out = await opLogEmail(client(), { subject: 'Hi', text: 'Body', associateToObjectType: 'tickets', associateToObjectId: 't9' }, 1000);
  assert.match(calls[0].url, /\/crm\/v3\/objects\/emails$/);
  assert.deepEqual(calls[0].body.properties, { hs_email_direction: 'EMAIL', hs_email_subject: 'Hi', hs_email_text: 'Body', hs_timestamp: 1000 });
  assert.match(calls[1].url, /\/crm\/v4\/objects\/emails\/e1\/associations\/default\/tickets\/t9$/);
  assert.match(out, /Attached to tickets t9/);
});

test('updateEngagement PATCHes, re-reads, and reports each property true / false / null', async () => {
  const calls = router((method) => (method === 'PATCH'
    ? { body: { id: 'n1' } }
    : { body: { id: 'n1', properties: { hs_note_body: 'new', hs_task_status: 'WAITING' } } }));
  const r = await performUpdateEngagement(client(), {
    engagementType: 'notes', engagementId: 'n1',
    properties: { hs_note_body: 'new', hs_task_status: 'COMPLETED', hs_timestamp: '2026-01-01' },
  });
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[1].url, /properties=hs_note_body,hs_task_status,hs_timestamp/);
  assert.deepEqual(r.confirmed, { hs_note_body: true, hs_task_status: false, hs_timestamp: null });
});

test('createTicket sends the pipeline and the required stage', async () => {
  const calls = router(() => ({ body: { id: 't1' } }));
  await performCreateTicket(client(), { subject: 'Broken', pipeline: '0', pipelineStage: '1', priority: 'HIGH' });
  assert.deepEqual(calls[0].body.properties, { subject: 'Broken', hs_pipeline: '0', hs_pipeline_stage: '1', hs_ticket_priority: 'HIGH' });
});

test('open tickets are found by the stages marked OPEN in the ticket pipelines', async () => {
  const calls = router((method, url) => (url.includes('/pipelines/tickets')
    ? { body: { results: [{ id: '0', stages: [
        { id: '1', metadata: { ticketState: 'OPEN' } },
        { id: '2', metadata: { ticketState: 'OPEN' } },
        { id: '4', metadata: { ticketState: 'CLOSED' } },
      ] }] } }
    : { body: { total: 0, results: [] } }));
  const r = await fetchTicketsSearch(client(), searchTicketsSchema.parse({ modifiedAfter: '2026-01-01T00:00:00Z' }));
  assert.deepEqual(r.stageFilter, ['1', '2']);
  const search = calls.find((c) => c.url.endsWith('/tickets/search'))!;
  assert.deepEqual(search.body.filterGroups[0].filters, [
    { propertyName: 'hs_pipeline_stage', operator: 'IN', values: ['1', '2'] },
    { propertyName: 'hs_lastmodifieddate', operator: 'GT', value: String(Date.parse('2026-01-01T00:00:00Z')) },
  ]);
});

test('a state no stage carries is refused rather than answered "no tickets"', async () => {
  router(() => ({ body: { results: [{ id: '0', stages: [{ id: '1' }] }] } }));
  await assert.rejects(() => fetchTicketsSearch(client(), searchTicketsSchema.parse({ state: 'closed' })), /No ticket pipeline stage is marked CLOSED/);
});

test('pipeline stages get the metadata their object type requires', async () => {
  const calls = router(() => ({ body: { id: 'p1', stages: [] } }));
  await performCreatePipeline(client(), createPipelineSchema.parse({
    objectType: 'tickets', label: 'Support', stages: [{ label: 'New', ticketState: 'OPEN' }, { label: 'Done', ticketState: 'CLOSED' }],
  }));
  assert.deepEqual(calls[0].body.stages, [
    { displayOrder: 0, label: 'New', metadata: { ticketState: 'OPEN' } },
    { displayOrder: 1, label: 'Done', metadata: { ticketState: 'CLOSED' } },
  ]);
  await assert.rejects(() => performCreatePipeline(client(), createPipelineSchema.parse({
    objectType: 'deals', label: 'Sales', stages: [{ label: 'Won' }],
  })), /needs probability/);
  await assert.rejects(() => performUpdatePipelineStage(client(), {
    objectType: 'deals', pipelineId: 'p', stageId: 's', ticketState: 'OPEN',
  }), /ticketState applies to ticket stages/);
});

test('listPipelines reads ticket pipelines and shows each stage open/closed state', async () => {
  router(() => ({ body: { results: [{ id: '0', label: 'Support', stages: [{ id: '1', label: 'New', metadata: { ticketState: 'OPEN' } }] }] } }));
  const out = await opListPipelines(client(), { objectType: 'tickets' });
  assert.match(out, /Found 1 ticket pipeline/);
  assert.match(out, /New \(id 1, open\)/);
});

test('logged emails can be deleted over MCP but not over REST', () => {
  assert.equal(deleteEngagementSchema.safeParse({ engagementType: 'emails', engagementId: 'e1' }).success, true);
  assert.equal(deleteEngagementRestSchema.safeParse({ engagementType: 'emails', engagementId: 'e1' }).success, false);
});
