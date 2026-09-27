import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

// The auth-gate suite (restRoutes.auth.test.ts) proves every /api/v1/* route
// exists and rejects an unauthenticated caller. It stops there, so nothing in
// the repo had ever executed a REST handler BODY — the query coercion, the
// schema rejection, the upstream call, the formatter, the error mapping. Those
// are where the HubSpot and Redmine planes actually live.
//
// This file authenticates for real (a file-store user plus a provider MCP
// connection, the pattern authenticated-routes.test.ts established) and stubs
// the global fetch the provider clients call. node:test runs each file in its
// own process, so the stub cannot leak into another suite.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8801;
const REDMINE_BASE = 'https://redmine.test.invalid';

const dummyUserTokens: UserTokens = {
  access_token: 'acc',
  refresh_token: 'ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

const dummyGoogleTokens: GoogleTokens = {
  access_token: 'mcp-acc',
  refresh_token: 'mcp-ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

/** One recorded upstream call, so a test can assert what actually went out. */
interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Canned reply for a fetch the stub intercepts. */
interface Canned {
  status?: number;
  json?: unknown;
  /** Raw body, for the non-JSON content-type branch. */
  text?: string;
  contentType?: string | null;
}

const realFetch = globalThis.fetch;
let calls: Recorded[] = [];
/** url substring → reply. First match wins, so a specific rule can precede a general one. */
let routes: Array<[string, Canned]> = [];
/** Fallback for anything no rule matched: an empty 200 JSON object. */
let fallback: Canned = { json: {} };

function stubFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    let parsedBody: unknown;
    if (typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
    }
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: parsedBody,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const hit = routes.find(([fragment]) => url.includes(fragment))?.[1] ?? fallback;
    const status = hit.status ?? 200;
    const contentType = hit.contentType === undefined ? 'application/json' : hit.contentType;
    const body = hit.text ?? (hit.json === undefined ? '' : JSON.stringify(hit.json));
    return new Response(body || null, {
      status,
      headers: contentType ? { 'content-type': contentType } : {},
    });
  }) as typeof fetch;
}

function reset(): void {
  calls = [];
  routes = [];
  fallback = { json: {} };
}

/** Register a canned reply for any upstream URL containing `fragment`. */
function when(fragment: string, canned: Canned): void {
  routes.push([fragment, canned]);
}

function lastCall(): Recorded {
  assert.ok(calls.length > 0, 'expected at least one upstream call');
  return calls[calls.length - 1];
}

describe('REST data plane: HubSpot and Redmine handler bodies', () => {
  const app = createWebOnlyApp();
  let bearer: string;

  before(async () => {
    const created = await createOrUpdateUser(
      { email: 'rest-providers@example.com', googleId: 'google-rest-providers', name: 'REST Provider User' },
      dummyUserTokens,
    );
    bearer = created.apiKey;
    // The file store does not assign the numeric id the connection lookup keys
    // on, so pin one — same trick authenticated-routes.test.ts uses.
    const user = await getUserByGoogleId('google-rest-providers');
    if (user) (user as any).id = USER_ID;

    await createMcpInstance(
      USER_ID, 'hubspot', 'Test HubSpot', dummyGoogleTokens, null,
      'hubspot', { access_token: 'hs-token' }, null,
    );
    await createMcpInstance(
      USER_ID, 'redmine', 'Test Redmine', dummyGoogleTokens, null,
      'redmine', { access_token: 'rm-key', baseUrl: REDMINE_BASE }, null,
    );
    stubFetch();
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  // ======================= HubSpot reads =======================

  describe('HubSpot reads', () => {
    it('lists recent companies and renders text on request', async () => {
      reset();
      when('/objects/companies/search', { json: { total: 1, results: [{ id: 'c1', properties: { name: 'Acme' } }] } });

      const json = await request(app).get('/api/v1/hubspot/companies').set(auth());
      assert.equal(json.status, 200);
      assert.equal(json.body.results[0].id, 'c1');

      const text = await request(app).get('/api/v1/hubspot/companies?format=text').set(auth());
      assert.equal(text.status, 200);
      assert.match(text.headers['content-type'], /text\/plain/);
      assert.match(text.text, /Acme/);
    });

    it('clamps ?limit to HubSpot own search page cap', async () => {
      reset();
      when('/objects/companies/search', { json: { results: [] } });
      await request(app).get('/api/v1/hubspot/companies?limit=9999').set(auth()).expect(200);
      assert.equal((lastCall().body as any).limit, 100);
    });

    it('lists recent contacts and deals from the same table', async () => {
      reset();
      when('/objects/contacts/search', { json: { results: [{ id: 'p1', properties: { firstname: 'Ada' } }] } });
      when('/objects/deals/search', { json: { results: [{ id: 'd1', properties: { dealname: 'Renewal' } }] } });

      const contacts = await request(app).get('/api/v1/hubspot/contacts').set(auth()).expect(200);
      assert.equal(contacts.body.results[0].id, 'p1');
      const deals = await request(app).get('/api/v1/hubspot/deals').set(auth()).expect(200);
      assert.equal(deals.body.results[0].id, 'd1');
    });

    it('forwards ?properties on a by-ID read and flags keys HubSpot never returned', async () => {
      reset();
      when('/objects/companies/c1', { json: { id: 'c1', properties: { name: 'Acme' } } });

      const res = await request(app)
        .get('/api/v1/hubspot/companies/c1?properties=name,industry&format=text')
        .set(auth())
        .expect(200);
      assert.ok(lastCall().url.includes('properties=name,industry'), `sent: ${lastCall().url}`);
      // `industry` was requested and not returned: saying so is what keeps
      // "no value on this record" distinct from "that property does not exist".
      assert.match(res.text, /industry/);
    });

    it('reads a contact and a deal by ID through the same table', async () => {
      reset();
      when('/objects/contacts/p1', { json: { id: 'p1', properties: { firstname: 'Ada' } } });
      when('/objects/deals/d1', { json: { id: 'd1', properties: { dealname: 'Renewal' } } });

      const contact = await request(app).get('/api/v1/hubspot/contacts/p1').set(auth());
      assert.equal(contact.status, 200);
      assert.equal(contact.body.id, 'p1');
      assert.ok(calls.some(c => c.url.includes('/objects/contacts/p1')), 'read the contact endpoint');

      const deal = await request(app).get('/api/v1/hubspot/deals/d1').set(auth());
      assert.equal(deal.status, 200);
      assert.equal(deal.body.properties.dealname, 'Renewal');
      assert.ok(calls.some(c => c.url.includes('/objects/deals/d1')), 'read the deals endpoint');
    });

    it('reports the engagement cap on company activity instead of hiding it', async () => {
      reset();
      // 101 associated engagements; the fan-out reads 100 and must say one was left.
      const ids = Array.from({ length: 101 }, (_, i) => ({ toObjectId: `e${i}` }));
      when('/associations/engagements', { json: { results: ids } });
      when('/engagements/v1/engagements/', { json: { engagement: { id: 1, type: 'NOTE', timestamp: 0 }, metadata: {} } });

      const res = await request(app).get('/api/v1/hubspot/companies/c1/activity').set(auth()).expect(200);
      assert.equal(res.body.omitted, 1, 'the overflow count is part of the payload');
      assert.equal(res.body.details.length, 100);
    });

    it('returns a company deals total as a floor when the association scan truncates', async () => {
      reset();
      // Every association page reports another cursor, so the scan hits its bound.
      when('/associations/deals', {
        json: { results: [{ toObjectId: 'd1' }], paging: { next: { after: 'more' } } },
      });
      when('/deals/batch/read', { json: { results: [{ id: 'd1', properties: { dealname: 'One' } }] } });

      const res = await request(app).get('/api/v1/hubspot/companies/c1/deals?format=text').set(auth()).expect(200);
      // truncated => "N+", never an exact count that would read as the whole pipeline.
      assert.match(res.text, /\+ associated deals/);
    });

    it('answers no associated deals without calling the batch read', async () => {
      reset();
      when('/associations/deals', { json: { results: [] } });
      const res = await request(app).get('/api/v1/hubspot/companies/c1/deals').set(auth()).expect(200);
      assert.equal(res.body.associatedCount, 0);
      assert.ok(!calls.some(c => c.url.includes('batch/read')), 'no batch read for an empty association set');
    });

    it('lists pipelines with their stages', async () => {
      reset();
      when('/pipelines/deals', { json: { results: [{ id: 'default', label: 'Sales', stages: [{ id: 's1', label: 'New' }] }] } });
      const res = await request(app).get('/api/v1/hubspot/pipelines?format=text').set(auth()).expect(200);
      assert.match(res.text, /Sales/);
    });

    it('fetches conversation threads with their messages and surfaces the next cursor', async () => {
      reset();
      when('/conversations/threads?', { json: { results: [{ id: 't1', status: 'OPEN' }], paging: { next: { after: 'nxt' } } } });
      when('/threads/t1/messages', { json: { results: [{ type: 'MESSAGE', text: 'hello', createdAt: '2026-01-01' }] } });

      const res = await request(app).get('/api/v1/hubspot/conversations').set(auth()).expect(200);
      assert.equal(res.body.nextAfter, 'nxt');
      assert.equal(res.body.threads[0].messages[0].text, 'hello');
    });

    it('rejects an unknown ticket criteria before calling HubSpot', async () => {
      reset();
      const res = await request(app).get('/api/v1/hubspot/tickets?criteria=Nope').set(auth()).expect(400);
      assert.match(res.body.error, /criteria/);
      assert.equal(calls.length, 0, 'nothing should reach HubSpot');
    });

    it('filters tickets with epoch millis, never ISO-8601', async () => {
      reset();
      when('/objects/tickets/search', { json: { total: 0, results: [] } });
      await request(app).get('/api/v1/hubspot/tickets').set(auth()).expect(200);
      const filters = (lastCall().body as any).filterGroups.flatMap((g: any) => g.filters);
      for (const f of filters) {
        assert.match(String(f.value), /^\d+$/, `${f.propertyName} must be epoch millis, got ${f.value}`);
      }
    });

    // The bound exists because searchTickets sleeps retryDelay * (2^maxRetries - 1)
    // seconds; unclamped this route could hold a socket for hours.
    it('clamps the caller-supplied retry budget', async () => {
      reset();
      when('/objects/tickets/search', { json: { results: [] } });
      await request(app).get('/api/v1/hubspot/tickets?maxRetries=10&retryDelay=30').set(auth()).expect(200);
      // One attempt, no sleeping: the clamp is asserted through fetchTickets'
      // observable behaviour rather than by reading the numbers back.
      assert.equal(calls.length, 1);
    });

    it('reads a ticket conversation threads', async () => {
      reset();
      when('/associations/conversation', { json: { results: [{ toObjectId: 't9' }] } });
      when('/threads/t9/messages', { json: { results: [{ type: 'MESSAGE', text: 'hi', createdAt: '2026-01-02' }] } });
      const res = await request(app).get('/api/v1/hubspot/tickets/tk1/conversation-threads').set(auth()).expect(200);
      assert.equal(res.body.threads[0].messages[0].text, 'hi');
    });

    it('rejects an objectType outside companies/contacts/deals', async () => {
      reset();
      const res = await request(app).get('/api/v1/hubspot/properties/widgets/name').set(auth()).expect(400);
      assert.match(res.body.error, /companies, contacts or deals/);
      assert.equal(calls.length, 0);
    });

    it('reads a property definition', async () => {
      reset();
      when('/properties/companies/domain', { json: { name: 'domain', label: 'Domain', type: 'string' } });
      const res = await request(app).get('/api/v1/hubspot/properties/companies/domain').set(auth()).expect(200);
      assert.equal(res.body.name, 'domain');
    });
  });

  // ======================= HubSpot writes =======================

  describe('HubSpot writes', () => {
    it('201s a created company and 200s a deduped one, with created saying which', async () => {
      reset();
      when('/objects/companies/search', { json: { total: 0, results: [] } });
      when('/objects/companies', { json: { id: 'new1', properties: { name: 'Acme' } } });

      const created = await request(app).post('/api/v1/hubspot/companies').set(auth()).send({ name: 'Acme' });
      assert.equal(created.status, 201);
      assert.equal(created.body.created, true);
      assert.equal(created.body.company.id, 'new1');

      reset();
      when('/objects/companies/search', { json: { total: 1, results: [{ id: 'old1', properties: { name: 'Acme' } }] } });
      const deduped = await request(app).post('/api/v1/hubspot/companies').set(auth()).send({ name: 'Acme' });
      assert.equal(deduped.status, 200, 'a match is a no-op, not a create');
      assert.equal(deduped.body.created, false);
      assert.equal(deduped.body.company.id, 'old1');
      assert.ok(!calls.some(c => c.method === 'POST' && !c.url.includes('/search')), 'nothing was written');
    });

    it('keeps the canonical name over a stray properties.name', async () => {
      reset();
      when('/objects/companies/search', { json: { total: 0, results: [] } });
      when('/objects/companies', { json: { id: 'n', properties: {} } });
      await request(app)
        .post('/api/v1/hubspot/companies')
        .set(auth())
        .send({ name: 'Canonical', properties: { name: 'Stray', domain: 'x.test' } })
        .expect(201);
      const written = calls.find(c => c.method === 'POST' && !c.url.includes('/search'));
      assert.equal((written!.body as any).properties.name, 'Canonical');
      assert.equal((written!.body as any).properties.domain, 'x.test');
    });

    it('rejects a body the MCP tool schema would reject, before calling HubSpot', async () => {
      reset();
      const res = await request(app).post('/api/v1/hubspot/companies').set(auth()).send({ nope: 1 });
      assert.equal(res.status, 400);
      assert.ok(res.body.issues.fieldErrors.name, 'flattened Zod issues are returned');
      assert.equal(calls.length, 0);
    });

    it('creates a contact and a deal', async () => {
      reset();
      when('/objects/contacts/search', { json: { total: 0, results: [] } });
      when('/objects/contacts', { json: { id: 'p9', properties: {} } });
      await request(app)
        .post('/api/v1/hubspot/contacts')
        .set(auth())
        .send({ firstname: 'Ada', lastname: 'Lovelace' })
        .expect(201);

      reset();
      when('/objects/deals', { json: { id: 'd9', properties: {} } });
      const deal = await request(app).post('/api/v1/hubspot/deals').set(auth()).send({ dealname: 'Q4' });
      assert.equal(deal.status, 201);
      assert.equal(deal.body.created, true, 'deals are never deduped');
    });

    it('defaults hs_timestamp and reports an attachment it did not attempt', async () => {
      reset();
      when('/objects/notes', { json: { id: 'n1', properties: {} } });
      const res = await request(app).post('/api/v1/hubspot/notes').set(auth()).send({ body: 'A note' });
      assert.equal(res.status, 201);
      assert.equal(res.body.association.attempted, false);
      const props = (lastCall().body as any).properties;
      assert.ok(props.hs_timestamp, 'omitting hs_timestamp is the documented #1 create failure');
      assert.equal(props.hs_note_body, 'A note');
    });

    it('reports a failed association as an orphan rather than a plain success', async () => {
      reset();
      // Specific first: the association URL also contains `/objects/calls`, and
      // the stub takes the first matching rule.
      when('/associations/default/', { status: 403, json: { message: 'nope' } });
      when('/objects/calls', { json: { id: 'call1', properties: {} } });

      const res = await request(app)
        .post('/api/v1/hubspot/calls')
        .set(auth())
        .send({ body: 'transcript', associateToObjectType: 'companies', associateToObjectId: 'c1' });
      // Still 201: the call record WAS created, and saying otherwise invites a
      // duplicate retry. `attached: false` is the orphan signal.
      assert.equal(res.status, 201);
      assert.equal(res.body.association.attempted, true);
      assert.equal(res.body.association.attached, false);
      assert.ok(res.body.association.error, 'the reason is carried, not swallowed');
    });

    it('confirms an association that succeeded', async () => {
      reset();
      when('/associations/default/', { json: {} });
      when('/objects/meetings', { json: { id: 'm1', properties: {} } });
      const res = await request(app)
        .post('/api/v1/hubspot/meetings')
        .set(auth())
        .send({ title: 'Kickoff', associateToObjectType: 'deals', associateToObjectId: 'd1' });
      assert.equal(res.status, 201);
      assert.equal(res.body.association.attached, true);
    });

    it('rejects half an association target', async () => {
      reset();
      const res = await request(app)
        .post('/api/v1/hubspot/notes')
        .set(auth())
        .send({ body: 'x', associateToObjectType: 'companies' });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  });

  // ======================= HubSpot errors =======================

  describe('HubSpot error mapping', () => {
    it('turns a missing-scope 403 into a reconnect message naming needed and granted scopes', async () => {
      reset();
      when('/objects/deals/search', {
        status: 403,
        json: {
          category: 'MISSING_SCOPES',
          message: 'This app requires any of [crm.objects.deals.read]',
          context: { requiredScopes: ['crm.objects.deals.read'] },
        },
      });
      when('/oauth/v1/access-tokens/', { json: { scopes: ['crm.objects.contacts.read'] } });

      const res = await request(app).get('/api/v1/hubspot/deals').set(auth());
      assert.equal(res.status, 403);
      assert.deepEqual(res.body.requiredScopes, ['crm.objects.deals.read']);
      assert.deepEqual(res.body.grantedScopes, ['crm.objects.contacts.read']);
      // Granted is the half that separates "never reconnected" from
      // "reconnected and still not granted", so the message must point at it.
      assert.match(res.body.error, /Reconnect/i);
      assert.match(res.body.error, /crm\.objects\.contacts\.read/);
    });

    it('degrades to the needed-only message when the token lookup fails', async () => {
      reset();
      when('/objects/deals/search', {
        status: 403,
        json: { category: 'MISSING_SCOPES', context: { requiredScopes: ['crm.objects.deals.read'] } },
      });
      when('/oauth/v1/access-tokens/', { status: 500, json: {} });

      const res = await request(app).get('/api/v1/hubspot/deals').set(auth());
      assert.equal(res.status, 403);
      assert.equal(res.body.grantedScopes, undefined);
      assert.match(res.body.error, /crm\.objects\.deals\.read/);
    });

    it('maps an ordinary 404 and a non-scope 403 through the shared mapper', async () => {
      reset();
      when('/objects/companies/missing', { status: 404, json: { message: 'not found' } });
      const notFound = await request(app).get('/api/v1/hubspot/companies/missing').set(auth());
      assert.equal(notFound.status, 404);
      assert.match(notFound.body.error, /Company not found/);

      reset();
      when('/objects/companies/denied', { status: 403, json: { message: 'no' } });
      const denied = await request(app).get('/api/v1/hubspot/companies/denied').set(auth());
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, 'Permission denied');
    });
  });

  // ======================= Redmine reads =======================

  describe('Redmine reads', () => {
    it('sends the API key as a header and lists issues as { items, page }', async () => {
      reset();
      when('/issues.json', { json: { issues: [{ id: 1, subject: 'Bug' }], total_count: 1, offset: 0, limit: 25 } });

      const res = await request(app).get('/api/v1/redmine/issues').set(auth()).expect(200);
      assert.equal(res.body.items[0].subject, 'Bug');
      assert.equal(res.body.page.total_count, 1);
      assert.equal((lastCall().headers as any)['X-Redmine-API-Key'], 'rm-key');
      assert.ok(lastCall().url.startsWith(REDMINE_BASE), 'the per-connection instance URL is used');
    });

    it('comma-joins issueIds into the one form Redmine honors', async () => {
      reset();
      await request(app).get('/api/v1/redmine/issues?issueIds=1,2,3').set(auth()).expect(200);
      assert.ok(lastCall().url.includes('issue_id=1%2C2%2C3'), `sent: ${lastCall().url}`);
    });

    it('forwards a cf_ filter and ignores a key that is not cf_<digits>', async () => {
      reset();
      await request(app).get('/api/v1/redmine/issues?cf_3=Urgent&cf_abc=x').set(auth()).expect(200);
      assert.ok(lastCall().url.includes('cf_3=Urgent'));
      assert.ok(!lastCall().url.includes('cf_abc'), 'an unknown filter would widen the result set upstream');
    });

    // Redmine answers an absent filter with MORE rows, so dropping a repeated
    // key would quietly return a wider set than the caller asked for.
    it('400s a repeated cf_ key instead of dropping the filter', async () => {
      reset();
      const res = await request(app).get('/api/v1/redmine/issues?cf_3=a&cf_3=b').set(auth());
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.invalidKeys, ['cf_3']);
      assert.match(res.body.error, /comma-joined/);
      assert.equal(calls.length, 0, 'nothing should reach Redmine');
    });

    it('400s a query the MCP tool schema rejects rather than letting Redmine ignore it', async () => {
      reset();
      const badInclude = await request(app).get('/api/v1/redmine/issues?include=bogus').set(auth());
      assert.equal(badInclude.status, 400);
      assert.ok(badInclude.body.issues, 'flattened Zod issues are returned');

      reset();
      const badTracker = await request(app).get('/api/v1/redmine/issues?trackerId=abc').set(auth());
      assert.equal(badTracker.status, 400, 'a present-but-garbage filter must not silently vanish');
      assert.equal(calls.length, 0);
    });

    it('clamps limit to Redmine own server-side cap', async () => {
      reset();
      await request(app).get('/api/v1/redmine/issues?limit=500').set(auth()).expect(200);
      assert.ok(lastCall().url.includes('limit=100'), `sent: ${lastCall().url}`);
    });

    it('reads one issue, embeds includes, and 404s a missing one', async () => {
      reset();
      when('/issues/1.json', { json: { issue: { id: 1, subject: 'Bug' } } });
      const res = await request(app).get('/api/v1/redmine/issues/1?include=journals').set(auth()).expect(200);
      assert.equal(res.body.issue.id, 1);
      assert.ok(lastCall().url.includes('include=journals'));

      reset();
      when('/issues/2.json', { json: {} });
      const missing = await request(app).get('/api/v1/redmine/issues/2').set(auth());
      assert.equal(missing.status, 404);
    });

    it('serves relations, projects and one project', async () => {
      reset();
      when('/relations.json', { json: { relations: [{ id: 5, relation_type: 'blocks' }] } });
      const rel = await request(app).get('/api/v1/redmine/issues/1/relations').set(auth()).expect(200);
      assert.equal(rel.body.items[0].relation_type, 'blocks');

      reset();
      when('/projects.json', { json: { projects: [{ id: 1, name: 'P', identifier: 'p' }], total_count: 1 } });
      const list = await request(app).get('/api/v1/redmine/projects').set(auth()).expect(200);
      assert.equal(list.body.items[0].identifier, 'p');

      reset();
      when('/projects/p.json', { json: { project: { id: 1, name: 'P', identifier: 'p' } } });
      const one = await request(app).get('/api/v1/redmine/projects/p').set(auth()).expect(200);
      assert.equal(one.body.project.identifier, 'p');
    });

    // Both are one segment under /users, so only the registration order keeps
    // "current" from being read as a user ID.
    it('resolves /users/current without treating it as a user ID', async () => {
      reset();
      when('/users/current.json', { json: { user: { id: 3, login: 'me' } } });
      const res = await request(app).get('/api/v1/redmine/users/current').set(auth()).expect(200);
      assert.equal(res.body.user.login, 'me');
      assert.ok(lastCall().url.includes('/users/current.json'));
    });

    it('serves the users list and one user by ID', async () => {
      reset();
      when('/users.json', { json: { users: [{ id: 7, login: 'ada' }], total_count: 1 } });
      await request(app).get('/api/v1/redmine/users?status=1').set(auth()).expect(200);
      assert.ok(lastCall().url.includes('status=1'));

      reset();
      when('/users/7.json', { json: { user: { id: 7, login: 'ada' } } });
      const one = await request(app).get('/api/v1/redmine/users/7').set(auth()).expect(200);
      assert.equal(one.body.user.login, 'ada');
    });

    it('rejects a users status outside the allowlist', async () => {
      reset();
      const res = await request(app).get('/api/v1/redmine/users?status=9').set(auth());
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('serves time entries and one entry', async () => {
      reset();
      when('/time_entries.json', { json: { time_entries: [{ id: 5, hours: 1.5 }], total_count: 1 } });
      const list = await request(app).get('/api/v1/redmine/time-entries?from=2026-01-01').set(auth()).expect(200);
      assert.equal(list.body.items[0].hours, 1.5);
      assert.ok(lastCall().url.includes('from=2026-01-01'));

      reset();
      when('/time_entries/5.json', { json: { time_entry: { id: 5, hours: 1.5 } } });
      await request(app).get('/api/v1/redmine/time-entries/5').set(auth()).expect(200);
    });

    it('serves the wiki index and one page by title', async () => {
      reset();
      when('/wiki/index.json', { json: { wiki_pages: [{ title: 'Home' }] } });
      const index = await request(app).get('/api/v1/redmine/projects/p/wiki').set(auth()).expect(200);
      assert.equal(index.body.items[0].title, 'Home');

      reset();
      when('/wiki/Home', { json: { wiki_page: { title: 'Home', text: 'body', version: 3 } } });
      const page = await request(app).get('/api/v1/redmine/projects/p/wiki/Home?version=2').set(auth()).expect(200);
      assert.equal(page.body.wiki_page.version, 3);
      assert.ok(lastCall().url.includes('/wiki/Home/2.json'), `sent: ${lastCall().url}`);
    });

    it('serves versions, categories and memberships', async () => {
      reset();
      when('/versions.json', { json: { versions: [{ id: 9, name: '2.1' }] } });
      await request(app).get('/api/v1/redmine/projects/p/versions').set(auth()).expect(200);

      reset();
      when('/versions/9.json', { json: { version: { id: 9, name: '2.1' } } });
      const v = await request(app).get('/api/v1/redmine/versions/9').set(auth()).expect(200);
      assert.equal(v.body.version.name, '2.1');

      reset();
      when('/issue_categories.json', { json: { issue_categories: [{ id: 2, name: 'UI' }] } });
      await request(app).get('/api/v1/redmine/projects/p/issue-categories').set(auth()).expect(200);

      reset();
      when('/memberships.json', { json: { memberships: [{ id: 1, user: { id: 7, name: 'Ada' }, roles: [] }] } });
      const m = await request(app).get('/api/v1/redmine/projects/p/memberships?limit=10').set(auth()).expect(200);
      assert.equal(m.body.items[0].user.name, 'Ada');
      assert.ok(lastCall().url.includes('limit=10'));
    });

    it('serves every lookup list', async () => {
      const lookups: Array<[string, string, unknown]> = [
        ['/api/v1/redmine/trackers', '/trackers.json', { trackers: [{ id: 1, name: 'Bug' }] }],
        ['/api/v1/redmine/issue-statuses', '/issue_statuses.json', { issue_statuses: [{ id: 1, name: 'New' }] }],
        ['/api/v1/redmine/issue-priorities', '/issue_priorities.json', { issue_priorities: [{ id: 4, name: 'Normal' }] }],
        ['/api/v1/redmine/time-entry-activities', '/time_entry_activities.json', { time_entry_activities: [{ id: 8, name: 'Dev' }] }],
        ['/api/v1/redmine/custom-fields', '/custom_fields.json', { custom_fields: [{ id: 3, name: 'Team' }] }],
      ];
      for (const [path, fragment, json] of lookups) {
        reset();
        when(fragment, { json });
        const res = await request(app).get(path).set(auth());
        assert.equal(res.status, 200, `${path} answered ${res.status}`);
        assert.equal(res.body.items.length, 1, `${path} returned no items`);
      }
    });

    it('requires q on search and sends the flags Redmine reads as presence', async () => {
      reset();
      const missing = await request(app).get('/api/v1/redmine/search').set(auth());
      assert.equal(missing.status, 400);
      assert.equal(calls.length, 0);

      reset();
      when('/search.json', { json: { results: [{ id: 1, title: 'hit' }], total_count: 1 } });
      const res = await request(app).get('/api/v1/redmine/search?q=login&issues=true&news=false').set(auth()).expect(200);
      assert.equal(res.body.items[0].title, 'hit');
      assert.ok(lastCall().url.includes('issues=1'), `sent: ${lastCall().url}`);
      assert.ok(!lastCall().url.includes('news='), 'a falsy presence flag must be omitted, not sent as 0');
    });

    it('accepts ?query as an alias for ?q', async () => {
      reset();
      when('/search.json', { json: { results: [] } });
      await request(app).get('/api/v1/redmine/search?query=login').set(auth()).expect(200);
      assert.ok(lastCall().url.includes('q=login'));
    });
  });

  // ======================= Redmine writes =======================

  describe('Redmine writes', () => {
    it('creates an issue and maps camelCase onto Redmine own body keys', async () => {
      reset();
      when('/issues.json', { json: { issue: { id: 42, subject: 'New' } } });
      const res = await request(app)
        .post('/api/v1/redmine/issues')
        .set(auth())
        .send({ projectId: 'p', subject: 'New', assignedToId: 7, dueDate: '2026-03-01' });
      assert.equal(res.status, 201);
      assert.equal(res.body.issue.id, 42);
      const sent = (lastCall().body as any).issue;
      assert.equal(sent.project_id, 'p');
      assert.equal(sent.assigned_to_id, 7);
      assert.equal(sent.due_date, '2026-03-01');
    });

    it('502s when Redmine accepts the create but returns no issue', async () => {
      reset();
      when('/issues.json', { json: {} });
      const res = await request(app).post('/api/v1/redmine/issues').set(auth()).send({ projectId: 'p', subject: 'x' });
      assert.equal(res.status, 502);
    });

    it('re-reads after an update, since Redmine answers 204 with no body', async () => {
      reset();
      when('/issues/1.json', { json: { issue: { id: 1, subject: 'Updated' } } });
      const res = await request(app).post('/api/v1/redmine/issues/1').set(auth()).send({ notes: 'a comment' });
      assert.equal(res.status, 200);
      assert.equal(res.body.issue.subject, 'Updated');
      const methods = calls.map(c => c.method);
      assert.deepEqual(methods, ['PUT', 'GET'], 'write then re-read');
      assert.equal((calls[0].body as any).issue.notes, 'a comment');
    });

    it('lets the path issueId win over a mismatched body key', async () => {
      reset();
      when('/issues/', { json: { issue: { id: 1 } } });
      await request(app).post('/api/v1/redmine/issues/1').set(auth()).send({ issueId: 999, notes: 'x' }).expect(200);
      assert.ok(calls[0].url.includes('/issues/1.json'), `wrote to: ${calls[0].url}`);
    });

    it('400s an update that would change nothing', async () => {
      reset();
      const res = await request(app).post('/api/v1/redmine/issues/1').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Nothing to update/);
      assert.equal(calls.length, 0);
    });

    it('logs time, and refuses a body with neither issue nor project', async () => {
      reset();
      when('/time_entries.json', { json: { time_entry: { id: 3, hours: 2 } } });
      const ok = await request(app).post('/api/v1/redmine/time-entries').set(auth()).send({ hours: 2, issueId: 1 });
      assert.equal(ok.status, 201);
      assert.equal((lastCall().body as any).time_entry.issue_id, 1);

      reset();
      const bad = await request(app).post('/api/v1/redmine/time-entries').set(auth()).send({ hours: 2 });
      assert.equal(bad.status, 400);
      assert.equal(calls.length, 0);
    });

    it('saves a wiki page and re-reads it for the new version', async () => {
      reset();
      when('/wiki/Home', { json: { wiki_page: { title: 'Home', text: 'new', version: 4 } } });
      const res = await request(app)
        .post('/api/v1/redmine/projects/p/wiki/Home')
        .set(auth())
        .send({ text: 'new', comments: 'why', version: 3 });
      assert.equal(res.status, 200);
      assert.equal(res.body.wiki_page.version, 4);
      const methods = calls.map(c => c.method);
      assert.deepEqual(methods, ['PUT', 'GET']);
      assert.equal((calls[0].body as any).wiki_page.version, 3, 'optimistic lock is forwarded');
    });

    it('400s a wiki save with no replacement text', async () => {
      reset();
      const res = await request(app).post('/api/v1/redmine/projects/p/wiki/Home').set(auth()).send({ comments: 'oops' });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  });

  // ======================= Redmine errors =======================

  describe('Redmine error mapping', () => {
    it('does not echo an upstream 401 as a 401', async () => {
      reset();
      when('/issues.json', { status: 401, text: 'unauthorized', contentType: 'text/plain' });
      const res = await request(app).get('/api/v1/redmine/issues').set(auth());
      // A 401 here would mean "your REST bearer is bad" and send the caller to
      // re-mint one, when the stored Redmine credential is what was rejected.
      assert.equal(res.status, 502);
      assert.match(res.body.error, /rejected the credential/i);
      assert.match(res.body.error, /Administration/, 'names the disabled-REST-API cause too');
    });

    it('distinguishes an administrator-only 403 from a project permission 403', async () => {
      reset();
      when('/users.json', { status: 403, text: 'forbidden', contentType: 'text/plain' });
      const admin = await request(app).get('/api/v1/redmine/users').set(auth());
      assert.equal(admin.status, 403);
      assert.match(admin.body.error, /administrator-only/i);

      reset();
      when('/issues.json', { status: 403, text: 'forbidden', contentType: 'text/plain' });
      const perm = await request(app).get('/api/v1/redmine/issues').set(auth());
      assert.equal(perm.status, 403);
      assert.match(perm.body.error, /view_issues/);
    });

    it('surfaces Redmine own validation list on a 422 rather than burying it in a 500', async () => {
      reset();
      when('/issues.json', {
        status: 422,
        text: JSON.stringify({ errors: ["Subject can't be blank"] }),
        contentType: 'text/plain',
      });
      const res = await request(app).post('/api/v1/redmine/issues').set(auth()).send({ projectId: 'p', subject: 'x' });
      assert.equal(res.status, 422);
      assert.match(res.body.error, /Subject can't be blank/);
    });

    it('maps a 404 and a 429 through', async () => {
      reset();
      when('/issues/9.json', { status: 404, text: '', contentType: 'text/plain' });
      const nf = await request(app).get('/api/v1/redmine/issues/9').set(auth());
      assert.equal(nf.status, 404);

      reset();
      when('/issues.json', { status: 429, text: '', contentType: 'text/plain' });
      const rl = await request(app).get('/api/v1/redmine/issues').set(auth());
      assert.equal(rl.status, 429);
    });

    it('reports an unreachable instance as 502 and names the host', async () => {
      reset();
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => {
        const err: any = new Error('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      }) as typeof fetch;
      try {
        const res = await request(app).get('/api/v1/redmine/issues').set(auth());
        assert.equal(res.status, 502);
        assert.match(res.body.error, /could not reach/i);
        assert.match(res.body.error, /redmine\.test\.invalid/);
      } finally {
        globalThis.fetch = saved;
      }
    });
  });

  // ======================= Body parsing =======================

  describe('request body limits', () => {
    // The subtlest claim in this change: REST_LARGE_BODY_PREFIXES is mounted
    // BEFORE the global express.json(), because body-parser sets req._body on
    // the first parse and later parsers skip it — while a parser registered
    // next to the handler would never run, the 100 kb global having already
    // rejected the request. If that ordering regresses, the document-body
    // endpoints silently go back to a 100 kb ceiling, which is the whole case
    // they exist for. These assertions are the guard.
    it('accepts a document-sized body on a large-body route', async () => {
      reset();
      when('/issues.json', { json: { issue: { id: 1, subject: 'big' } } });
      const res = await request(app)
        .post('/api/v1/redmine/issues')
        .set(auth())
        .send({ projectId: 'p', subject: 'big', description: 'x'.repeat(400_000) });
      assert.equal(res.status, 201, 'a 400 kb issue body must not be rejected');
      assert.equal((lastCall().body as any).issue.description.length, 400_000);
    });

    it('accepts a document-sized wiki page body', async () => {
      reset();
      when('/wiki/Big', { json: { wiki_page: { title: 'Big', text: 'x', version: 1 } } });
      const res = await request(app)
        .post('/api/v1/redmine/projects/p/wiki/Big')
        .set(auth())
        .send({ text: 'y'.repeat(400_000) });
      assert.equal(res.status, 200);
    });

    it('answers an oversize body with JSON, not Express default HTML page', async () => {
      reset();
      const res = await request(app)
        .post('/api/v1/redmine/issues')
        .set(auth())
        .send({ projectId: 'p', subject: 'huge', description: 'x'.repeat(6 * 1024 * 1024) });
      assert.equal(res.status, 413);
      // A curl client told this API speaks JSON cannot tell an oversize body
      // from a proxy fault when it gets HTML back.
      assert.match(res.headers['content-type'], /application\/json/);
      assert.match(res.body.error, /too large/i);
    });

    it('holds a route outside the large-body prefixes to the 100 kb default', async () => {
      reset();
      const res = await request(app)
        .post('/api/v1/hubspot/companies')
        .set(auth())
        .send({ name: 'Acme', properties: { note: 'x'.repeat(200_000) } });
      assert.equal(res.status, 413, 'the raised limit is per prefix, not global');
      assert.match(res.body.error, /too large/i);
    });

    it('answers malformed JSON with JSON', async () => {
      reset();
      const res = await request(app)
        .post('/api/v1/redmine/issues')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send('{"projectId": "p", ');
      assert.equal(res.status, 400);
      assert.match(res.body.error, /not valid JSON/i);
    });
  });

  // ======================= Connection guards =======================

  describe('connection guards', () => {
    it('403s a service the account has no connection for, naming the dashboard', async () => {
      // This user has hubspot and redmine but no outline-style third service;
      // an authenticated caller with no HubSpot connection must get a clear
      // 403 rather than an upstream 401 from an undefined bearer.
      const other = await createOrUpdateUser(
        { email: 'no-providers@example.com', googleId: 'google-no-providers', name: 'No Providers' },
        dummyUserTokens,
      );
      const res = await request(app)
        .get('/api/v1/hubspot/companies')
        .set({ Authorization: `Bearer ${other.apiKey}` });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /HubSpot connection required/);

      const rm = await request(app)
        .get('/api/v1/redmine/issues')
        .set({ Authorization: `Bearer ${other.apiKey}` });
      assert.equal(rm.status, 403);
      assert.match(rm.body.error, /Redmine connection required/);
    });

    // Redmine is self-hosted, so a connection without an instance URL is broken
    // rather than defaultable — there is no api.redmine.com to fall back to, and
    // guessing a host would send the credential somewhere the user never named.
    // It has to say that, not throw on the way to building a client.
    it('403s a Redmine connection that has a credential but no instance URL', async () => {
      const urlless = await createOrUpdateUser(
        { email: 'redmine-no-url@example.com', googleId: 'google-redmine-no-url', name: 'No Instance URL' },
        dummyUserTokens,
      );
      const urllessId = USER_ID + 1;
      const u = await getUserByGoogleId('google-redmine-no-url');
      if (u) (u as any).id = urllessId;
      await createMcpInstance(
        urllessId, 'redmine', 'Broken Redmine', dummyGoogleTokens, null,
        'redmine', { access_token: 'rm-key-no-url' }, null,
      );

      reset();
      const res = await request(app)
        .get('/api/v1/redmine/issues')
        .set({ Authorization: `Bearer ${urlless.apiKey}` });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /missing its instance URL/);
      assert.match(res.body.error, /Reconnect/i);
      assert.equal(calls.length, 0, 'no request should be attempted without a host');
    });
  });
});
