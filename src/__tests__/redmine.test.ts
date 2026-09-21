// src/__tests__/redmine.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import { redmineServer, createIssueSchema, updateIssueSchema, createTimeEntrySchema } from '../redmine/server.js';
import {
  RedmineClient,
  appendQueryParams,
  formatIssue,
  formatIssueList,
  formatRefList,
  formatTimeEntryList,
  getRedmineClient,
  mapRedmineError,
  mergeCustomFieldFilters,
  renderPageLine,
} from '../redmine/apiHelpers.js';
import type { UserSession } from '../userSession.js';

const silentLog = { info: () => {}, error: () => {} };

test('redmine server is registered', () => {
  assert.ok(redmineServer, 'server should be defined');
});

// ---------------------------------------------------------------------------
// Pagination reporting. Redmine caps `limit` at 100, so any larger collection
// comes back cut; a list that does not say so reads as "that is everything".
// ---------------------------------------------------------------------------

describe('renderPageLine', () => {
  test('names the window and how to get the next page', () => {
    assert.equal(
      renderPageLine({ total_count: 412, offset: 0, limit: 25 }, 25),
      'Showing 1-25 of 412. — more available; pass offset=25 to fetch the next page.',
    );
  });

  test('omits the "more available" hint on the last page', () => {
    const line = renderPageLine({ total_count: 30, offset: 25, limit: 25 }, 5);
    assert.equal(line, 'Showing 26-30 of 30.');
    assert.doesNotMatch(line, /more available/);
  });

  test('handles an empty collection', () => {
    assert.equal(renderPageLine({ total_count: 0, offset: 0, limit: 25 }, 0), 'Showing 0 of 0.');
  });

  test('degrades to a bare count when Redmine sends no total', () => {
    assert.equal(renderPageLine({}, 3), '3 returned.');
    assert.equal(renderPageLine(undefined, 0), null);
  });
});

describe('list formatters report their extent', () => {
  test('formatIssueList leads with the page line', () => {
    const out = formatIssueList(
      [{ id: 1, subject: 'Login fails', status: { id: 1, name: 'New' }, project: { id: 2, name: 'Platform' } }],
      { total_count: 90, offset: 0, limit: 1 },
    );
    assert.match(out, /^# Issues/);
    assert.match(out, /Showing 1-1 of 90/);
    assert.match(out, /more available; pass offset=1/);
    assert.match(out, /#1 Login fails/);
    assert.match(out, /Status: New \(#1\)/);
  });

  test('an unassigned issue says so rather than omitting the field', () => {
    const out = formatIssueList([{ id: 7, subject: 'x' }], { total_count: 1, offset: 0 });
    assert.match(out, /Assignee: unassigned/);
  });

  // "No results" and "you paged past the end" are different answers, and only
  // the second means the caller should go back.
  test('paging past the end says so instead of reporting emptiness', () => {
    const out = formatIssueList([], { total_count: 10, offset: 50, limit: 25 });
    assert.match(out, /offset 50 is past the end of 10 total/);
  });

  test('a genuinely empty collection reports no results', () => {
    assert.equal(formatIssueList([], { total_count: 0, offset: 0 }), 'No issues found.');
  });

  // The sum is page-scoped; saying otherwise would invent a total.
  test('formatTimeEntryList scopes its total to the page', () => {
    const out = formatTimeEntryList(
      [{ id: 1, hours: 1.5, spent_on: '2026-09-01' }, { id: 2, hours: 2, spent_on: '2026-09-02' }],
      { total_count: 40, offset: 0, limit: 2 },
    );
    assert.match(out, /Hours on this page: 3.5/);
    assert.match(out, /Showing 1-2 of 40/);
  });

  test('formatRefList surfaces IDs and flags', () => {
    const out = formatRefList('Issue statuses', 'issue statuses', [
      { id: 1, name: 'New', is_default: true },
      { id: 5, name: 'Closed', is_closed: true },
    ]);
    assert.match(out, /New — ID: 1 \[default\]/);
    assert.match(out, /Closed — ID: 5 \[closed status\]/);
  });
});

describe('formatIssue', () => {
  test('renders history, subtasks and relations when included', () => {
    const out = formatIssue({
      id: 42,
      subject: 'Crash on save',
      description: 'Steps to reproduce…',
      status: { id: 2, name: 'In Progress' },
      children: [{ id: 43, subject: 'Add regression test', status: { id: 1, name: 'New' } }],
      relations: [{ id: 9, issue_id: 42, issue_to_id: 50, relation_type: 'blocks' }],
      journals: [{ id: 1, user: { id: 3, name: 'J Smith' }, notes: 'Reproduced.', created_on: '2026-09-01T10:00:00Z',
                   details: [{ name: 'status_id', old_value: '1', new_value: '2' }] }],
      allowed_statuses: [{ id: 3, name: 'Resolved' }],
    });
    assert.match(out, /# Issue #42: Crash on save/);
    assert.match(out, /## Description/);
    assert.match(out, /## Subtasks/);
    assert.match(out, /#43 Add regression test \[New\]/);
    assert.match(out, /issue #42 blocks issue #50/);
    assert.match(out, /## History/);
    assert.match(out, /status_id: 1 → 2/);
    assert.match(out, /Allowed next statuses: Resolved \(#3\)/);
  });

  test('a bare issue renders without throwing', () => {
    assert.match(formatIssue({ id: 1 }), /# Issue #1: \(no subject\)/);
  });
});

// ---------------------------------------------------------------------------
// Query serialization. Redmine ignores filters it does not recognise, which
// turns a wrong key into a plausible-looking wrong answer rather than an error.
// ---------------------------------------------------------------------------

describe('appendQueryParams', () => {
  test('joins arrays with commas, not repeated keys', () => {
    const url = new URL('https://r.example.com/issues.json');
    appendQueryParams(url, { issue_id: [1, 2, 3] });
    assert.equal(url.searchParams.get('issue_id'), '1,2,3');
    assert.equal(url.searchParams.getAll('issue_id').length, 1);
  });

  test('drops null, undefined and empty values', () => {
    const url = new URL('https://r.example.com/issues.json');
    appendQueryParams(url, { a: undefined, b: null, c: '', d: 0, e: false, f: [] });
    assert.equal(url.search, '?d=0&e=false');
  });
});

describe('mergeCustomFieldFilters', () => {
  test('passes through cf_<id> keys', () => {
    assert.deepEqual(mergeCustomFieldFilters({ project_id: 'p' }, { cf_3: 'Urgent' }), { project_id: 'p', cf_3: 'Urgent' });
  });

  // A forwarded bogus key would be ignored upstream and silently widen results.
  test('drops keys that are not cf_<number>', () => {
    assert.deepEqual(mergeCustomFieldFilters({}, { severity: 'high', cf_x: '1', cf_12: 'ok' }), { cf_12: 'ok' });
  });

  test('is a no-op when no custom fields are given', () => {
    const base = { project_id: 'p' };
    assert.deepEqual(mergeCustomFieldFilters(base, undefined), base);
  });
});

// ---------------------------------------------------------------------------
// Error mapping. 401 and 403 mean opposite things on Redmine and must not be
// collapsed into one "check your credentials".
// ---------------------------------------------------------------------------

describe('mapRedmineError', () => {
  const mapped = (status: number, body?: string) => {
    try {
      mapRedmineError('Failed to do thing', Object.assign(new Error('boom'), { status, body }), silentLog);
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.ok(err instanceof UserError, 'must throw UserError so it surfaces through MCP');
      return err.message as string;
    }
  };

  test('403 points at the admin setting, not the credential', () => {
    const m = mapped(403);
    assert.match(m, /Enable REST API/);
    assert.match(m, /lacks the permission/);
  });

  test('401 mentions the pre-4.1 ambiguity', () => {
    assert.match(mapped(401), /older than 4\.1/);
  });

  test('404 warns that Redmine hides records you cannot see', () => {
    assert.match(mapped(404), /not allowed to see/);
  });

  test('422 surfaces the field-level validation messages verbatim', () => {
    assert.match(
      mapped(422, JSON.stringify({ errors: ['Subject cannot be blank', 'Tracker is invalid'] })),
      /Subject cannot be blank; Tracker is invalid/,
    );
  });

  test('422 with an unparseable body still gives actionable guidance', () => {
    assert.match(mapped(422, '<html>nope</html>'), /Check required fields/);
  });

  test('429 reports rate limiting', () => {
    assert.match(mapped(429), /rate limited/);
  });
});

describe('getRedmineClient', () => {
  test('rejects a session with no token', () => {
    assert.throws(() => getRedmineClient({} as UserSession), /not connected/);
  });

  // No default host is possible, so a missing base URL is a broken connection
  // rather than something to paper over with a guess.
  test('rejects a session with a token but no base URL', () => {
    assert.throws(
      () => getRedmineClient({ redmineAccessToken: 'k' } as unknown as UserSession),
      /missing its instance URL/,
    );
  });

  test('builds a client and strips the trailing slash', () => {
    const client = getRedmineClient({
      redmineAccessToken: 'k',
      redmineBaseUrl: 'https://redmine.example.com/',
    } as unknown as UserSession);
    assert.ok(client instanceof RedmineClient);
    assert.equal(client.baseUrl, 'https://redmine.example.com');
  });
});

// ---------------------------------------------------------------------------
// Exported schemas — shared with any future REST sibling, so their guards are
// the contract rather than an implementation detail.
// ---------------------------------------------------------------------------

describe('exported Zod schemas', () => {
  test('createIssueSchema requires a project and a subject', () => {
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', subject: 'x' }).success, true);
    assert.equal(createIssueSchema.safeParse({ subject: 'x' }).success, false);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p' }).success, false);
  });

  test('createIssueSchema rejects impossible calendar dates', () => {
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', subject: 'x', dueDate: '2026-02-31' }).success, false);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', subject: 'x', dueDate: '2026-02-28' }).success, true);
  });

  test('createIssueSchema bounds doneRatio to 0-100', () => {
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', subject: 'x', doneRatio: 101 }).success, false);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', subject: 'x', doneRatio: 100 }).success, true);
  });

  test('updateIssueSchema needs only the issue id', () => {
    assert.equal(updateIssueSchema.safeParse({ issueId: 1 }).success, true);
    assert.equal(updateIssueSchema.safeParse({}).success, false);
  });

  // Redmine needs one or the other; sending neither is a 422 round-trip we can
  // refuse locally.
  test('createTimeEntrySchema demands an issue or a project', () => {
    assert.equal(createTimeEntrySchema.safeParse({ hours: 1 }).success, false);
    assert.equal(createTimeEntrySchema.safeParse({ hours: 1, issueId: 5 }).success, true);
    assert.equal(createTimeEntrySchema.safeParse({ hours: 1, projectId: 'p' }).success, true);
  });

  test('createTimeEntrySchema rejects non-positive hours', () => {
    assert.equal(createTimeEntrySchema.safeParse({ hours: 0, issueId: 5 }).success, false);
    assert.equal(createTimeEntrySchema.safeParse({ hours: -1, issueId: 5 }).success, false);
  });
});
