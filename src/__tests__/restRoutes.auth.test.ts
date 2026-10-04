import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebApp } from '../website/webServer.js';

// Set dummy Google credentials so createWebOnlyApp does not throw.
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

// Every new REST data-plane GET endpoint is wrapped in a service-specific
// `requireApiKey` middleware. These tests exercise the unauthenticated path:
//   - no Authorization header → 401
//   - syntactically valid but unknown bearer → 401
// They do not require any upstream Google/Slack/ClickUp mocking, so they
// cover the routes' presence + auth gate cheaply.
const NEW_REST_ENDPOINTS: ReadonlyArray<string> = [
  '/api/v1/docs',
  '/api/v1/docs/recent',
  '/api/v1/docs/doc-123',
  '/api/v1/docs/doc-123/tabs',
  '/api/v1/docs/doc-123/comments/comment-123',
  '/api/v1/docs/doc-123/structure',
  '/api/v1/drive/shared-drives',
  '/api/v1/drive/folders/folder-123',
  '/api/v1/drive/files/file-123/permissions',
  '/api/v1/drive/files/file-123/public',
  '/api/v1/gmail/labels',
  '/api/v1/slides/presentation-123/pages/page-123/thumbnail',
  '/api/v1/slides/presentation-123/comments',
  '/api/v1/sheets/sheet-123/ranges?range=A1:B2',
  '/api/v1/sheets/sheet-123/rows/1',
  '/api/v1/sheets/sheet-123/search?col=A&val=x',
  '/api/v1/clickup/docs/doc-123?workspaceId=w-1',
  '/api/v1/clickup/docs/doc-123/pages/page-123?workspaceId=w-1',
  '/api/v1/clickup/workspaces/w-1/docs',
  '/api/v1/clickup/workspaces/w-1/docs/search?query=sync',
  '/api/v1/slack/channels',
  '/api/v1/slack/channels/C123/messages',
  '/api/v1/slack/channels/C123/threads/1234.5678',
  '/api/v1/slack/users',
  '/api/v1/drive/files/file-123/download',
  '/api/v1/gmail/messages/m-1/attachments/a-1',
  '/api/v1/clickup/workspaces/w-1/members',
  '/api/v1/peopleforce/employees',
  '/api/v1/peopleforce/employees/emp-123',
  '/api/v1/peopleforce/departments',
  '/api/v1/peopleforce/leave-requests',
  '/api/v1/peopleforce/leave-requests/lr-123',
  '/api/v1/peopleforce/leave-types',
  '/api/v1/peopleforce/positions',
  '/api/v1/peopleforce/divisions',
  '/api/v1/peopleforce/locations',
  '/api/v1/peopleforce/employment-types',
  '/api/v1/peopleforce/job-levels',
  '/api/v1/peopleforce/skills',
  '/api/v1/peopleforce/competencies',
  '/api/v1/peopleforce/tasks',
  '/api/v1/peopleforce/objectives',
  '/api/v1/peopleforce/kpis',
  '/api/v1/peopleforce/employee-tables',
  '/api/v1/peopleforce/employees/emp-123/leave-balances',
  '/api/v1/peopleforce/employees/emp-123/skills',
  '/api/v1/peopleforce/employees/emp-123/documents',
  '/api/v1/peopleforce/employees/emp-123/notes',
  '/api/v1/peopleforce/employees/emp-123/emergency-contacts',
  '/api/v1/peopleforce/employees/emp-123/tables/timeline',
  '/api/v1/peopleforce/knowledge-base/categories',
  '/api/v1/peopleforce/knowledge-base/articles?categoryId=cat-1',
  '/api/v1/peopleforce/knowledge-base/articles/art-123',
  '/api/v1/peopleforce/recruitment/vacancies',
  '/api/v1/peopleforce/recruitment/vacancies/vac-123',
  '/api/v1/peopleforce/recruitment/vacancies/vac-123/applications',
  '/api/v1/peopleforce/recruitment/vacancies/vac-123/applications/app-123',
  '/api/v1/peopleforce/recruitment/published-vacancies/vac-123',
  '/api/v1/peopleforce/recruitment/pipelines',
  '/api/v1/peopleforce/recruitment/candidates',
  '/api/v1/peopleforce/recruitment/candidates/cand-123',
  '/api/v1/peopleforce/recruitment/candidates/cand-123/dossier',
  '/api/v1/peopleforce/recruitment/candidates/cand-123/notes',
  '/api/v1/peopleforce/recruitment/candidates/cand-123/experiences',
  '/api/v1/peopleforce/recruitment/candidates/cand-123/educations',
  '/api/v1/peopleforce/recruitment/candidate-movements',
  '/api/v1/peopleforce/recruitment/disqualify-reasons',
  '/api/v1/peopleforce/recruitment/sources',
  // HubSpot
  '/api/v1/hubspot/companies',
  '/api/v1/hubspot/companies/comp-123',
  '/api/v1/hubspot/companies/comp-123/activity',
  '/api/v1/hubspot/companies/comp-123/deals',
  '/api/v1/hubspot/contacts',
  '/api/v1/hubspot/contacts/cont-123',
  '/api/v1/hubspot/deals',
  '/api/v1/hubspot/deals/deal-123',
  '/api/v1/hubspot/pipelines',
  '/api/v1/hubspot/conversations',
  '/api/v1/hubspot/tickets',
  '/api/v1/hubspot/tickets/tick-123/conversation-threads',
  '/api/v1/hubspot/properties/companies/domain',
  // Redmine. /users/current is listed alongside /users/:userId on purpose: both
  // are one segment under /users, so the only thing keeping "current" from being
  // read as a user ID is the registration order in webServer.ts.
  '/api/v1/redmine/issues',
  '/api/v1/redmine/issues/123',
  '/api/v1/redmine/issues/123/relations',
  '/api/v1/redmine/projects',
  '/api/v1/redmine/projects/my-project',
  '/api/v1/redmine/projects/my-project/wiki',
  '/api/v1/redmine/projects/my-project/wiki/Home',
  '/api/v1/redmine/projects/my-project/versions',
  '/api/v1/redmine/projects/my-project/issue-categories',
  '/api/v1/redmine/projects/my-project/memberships',
  '/api/v1/redmine/users',
  '/api/v1/redmine/users/current',
  '/api/v1/redmine/users/7',
  '/api/v1/redmine/time-entries',
  '/api/v1/redmine/time-entries/55',
  '/api/v1/redmine/versions/9',
  '/api/v1/redmine/trackers',
  '/api/v1/redmine/issue-statuses',
  '/api/v1/redmine/issue-priorities',
  '/api/v1/redmine/time-entry-activities',
  '/api/v1/redmine/custom-fields',
  '/api/v1/redmine/search?q=login',
  // ClickUp reads
  '/api/v1/clickup/workspaces/ws-123/task-types',
  '/api/v1/clickup/spaces/space-123/tags',
  // Outline reads. The five STATIC document paths are listed first on purpose:
  // they are registered before /documents/:documentId, and if that ordering ever
  // regresses they stop being their own routes — which this array would not
  // catch on its own (both still answer 401), so keep them adjacent to the
  // parameterized one as a reminder that the order is load-bearing.
  '/api/v1/outline/documents/search?q=policy',
  '/api/v1/outline/documents/recent',
  '/api/v1/outline/documents/archived',
  '/api/v1/outline/documents/trash',
  '/api/v1/outline/documents/by-title?q=Handbook',
  '/api/v1/outline/documents/doc-123',
  '/api/v1/outline/documents/doc-123/export',
  '/api/v1/outline/documents/doc-123/backlinks',
  '/api/v1/outline/documents/doc-123/comments',
  '/api/v1/outline/documents/doc-123/attachments',
  '/api/v1/outline/collections',
  '/api/v1/outline/collections/col-123/structure',
  '/api/v1/outline/collections/col-123/export',
  '/api/v1/outline/comments/cmt-123',
  '/api/v1/outline/attachments/att-123/url',
  '/api/v1/outline/exports',
];

// POST endpoints — same auth gate, exercised with the right verb. Bodies are
// intentionally empty: the middleware rejects before any body parsing, so a 401
// here proves the gate runs ahead of validation and an unauthenticated caller
// can't probe the schema by watching 400s.
const NEW_REST_WRITE_ENDPOINTS: ReadonlyArray<string> = [
  '/api/v1/peopleforce/leave-requests',
  '/api/v1/peopleforce/recruitment/candidates/cand-123/notes',
  '/api/v1/peopleforce/recruitment/vacancies/vac-123/applications/app-123/move',
  '/api/v1/peopleforce/recruitment/vacancies/vac-123/applications/app-123/disqualify',
  // HubSpot. Note /companies, /contacts and /deals are in BOTH arrays — the GET
  // is the list, the POST is the create, and only the verb tells them apart.
  '/api/v1/hubspot/companies',
  '/api/v1/hubspot/contacts',
  '/api/v1/hubspot/deals',
  '/api/v1/hubspot/notes',
  '/api/v1/hubspot/calls',
  '/api/v1/hubspot/meetings',
  // Redmine
  '/api/v1/redmine/issues',
  '/api/v1/redmine/issues/123',
  '/api/v1/redmine/time-entries',
  '/api/v1/redmine/projects/my-project/wiki/Home',
  // Google Docs writes — one per write tool. Note '/api/v1/docs/{id}/comments'
  // is in both arrays: GET lists the comments, POST adds one.
  '/api/v1/docs/import',
  '/api/v1/docs/import/docx',
  '/api/v1/docs/doc-123/append',
  '/api/v1/docs/doc-123/text',
  '/api/v1/docs/doc-123/batchUpdate',
  '/api/v1/docs/doc-123/find-replace',
  '/api/v1/docs/doc-123/ranges/delete',
  '/api/v1/docs/doc-123/text-style',
  '/api/v1/docs/doc-123/paragraph-style',
  '/api/v1/docs/doc-123/format-matching-text',
  '/api/v1/docs/doc-123/tables',
  '/api/v1/docs/doc-123/page-breaks',
  '/api/v1/docs/doc-123/images/from-url',
  '/api/v1/docs/doc-123/images',
  '/api/v1/docs/doc-123/export/pdf',
  '/api/v1/docs/doc-123/comments',
  '/api/v1/docs/doc-123/comments/cmt-1/replies',
  '/api/v1/docs/doc-123/comments/cmt-1/resolve',
  '/api/v1/docs/doc-123/comments/cmt-1/delete',
  // Google Sheets writes. '/api/v1/sheets' is in BOTH arrays — the GET lists
  // spreadsheets, the POST creates one.
  '/api/v1/sheets',
  '/api/v1/sheets/sheet-123/write',
  '/api/v1/sheets/sheet-123/append',
  '/api/v1/sheets/sheet-123/batchUpdate',
  '/api/v1/sheets/sheet-123/ranges/clear',
  // Google Calendar writes. The events path is in both arrays for the same
  // reason: GET lists, POST creates.
  '/api/v1/calendars/primary/events',
  '/api/v1/calendars/primary/events/evt-123',
  '/api/v1/calendars/primary/events/evt-123/cancel',
  // ClickUp writes that were already SERVED but uncatalogued (ChatGPT Custom
  // Actions compat) and are now in the catalog. Listed here because nothing else
  // asserted their auth gate, and they mutate ClickUp.
  '/api/v1/clickup/spaces/ws-123',
  '/api/v1/clickup/spaces/space-123/folders',
  '/api/v1/clickup/folders/folder-123/lists',
  '/api/v1/clickup/lists/list-123/tasks',
  '/api/v1/clickup/tasks/task-123/move',
  '/api/v1/clickup/tasks/task-123/comments',
  '/api/v1/clickup/tasks/task-123/fields/field-123',
  '/api/v1/clickup/workspaces/ws-123/time/start',
  '/api/v1/clickup/workspaces/ws-123/time/stop',
  '/api/v1/images',
  // ClickUp writes on the new camelCase action paths.
  '/api/v1/clickup/tasks/task-123/update',
  '/api/v1/clickup/tasks/task-123/delete',
  '/api/v1/clickup/lists/list-123/update',
  '/api/v1/clickup/lists/list-123/delete',
  '/api/v1/clickup/tasks/task-123/fields/field-123/remove',
  '/api/v1/clickup/tasks/task-123/lists/list-123',
  '/api/v1/clickup/tasks/task-123/lists/list-123/remove',
  '/api/v1/clickup/tasks/task-123/tags/urgent',
  '/api/v1/clickup/tasks/task-123/tags/urgent/remove',
  '/api/v1/clickup/workspaces/ws-123/docs',
  '/api/v1/clickup/workspaces/ws-123/docs/doc-123/pages',
  '/api/v1/clickup/workspaces/ws-123/docs/doc-123/pages/page-123',
  '/api/v1/clickup/workspaces/ws-123/docs/doc-123/pages/page-123/images',
  // Outline writes. '/documents', '/documents/{id}', '/collections' and
  // '/collections/{id}' are in BOTH arrays — the GET reads, the POST writes.
  '/api/v1/outline/documents',
  '/api/v1/outline/documents/doc-123',
  '/api/v1/outline/documents/doc-123/move',
  '/api/v1/outline/documents/doc-123/archive',
  '/api/v1/outline/documents/doc-123/unarchive',
  '/api/v1/outline/documents/doc-123/restore',
  '/api/v1/outline/documents/doc-123/comments',
  '/api/v1/outline/collections',
  '/api/v1/outline/collections/col-123',
];

describe('REST data-plane: auth gate', () => {
  let app: ReturnType<typeof createWebApp>;

  before(() => {
    // Ports are unused — the REST routes we test live under /api/v1/*, which
    // don't overlap the MCP proxy path filters (/mcp, /calendar, /sheets, …),
    // so the proxy targets being unreachable doesn't affect this test.
    app = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  for (const path of NEW_REST_ENDPOINTS) {
    it(`GET ${path} → 401 when Authorization is missing`, async () => {
      const res = await request(app).get(path);
      assert.equal(res.status, 401);
      assert.ok(res.body.error, 'expected an error body');
    });

    it(`GET ${path} → 401 when the bearer is unknown`, async () => {
      const res = await request(app).get(path).set('Authorization', 'Bearer not-a-real-token');
      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    });
  }

  for (const path of NEW_REST_WRITE_ENDPOINTS) {
    it(`POST ${path} → 401 when Authorization is missing`, async () => {
      const res = await request(app).post(path).send({});
      assert.equal(res.status, 401);
      assert.ok(res.body.error, 'expected an error body');
    });

    it(`POST ${path} → 401 when the bearer is unknown`, async () => {
      const res = await request(app).post(path).set('Authorization', 'Bearer not-a-real-token').send({});
      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    });
  }
});
