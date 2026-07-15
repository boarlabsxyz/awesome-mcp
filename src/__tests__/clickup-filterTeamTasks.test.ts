import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ClickUpClient } from '../clickup/apiHelpers.js';

// Intercepts the global fetch to capture the URL/method the client would send.
// Returns a tuple of (client, getCalls) where getCalls().at(-1) is the most recent request.
function withMockedFetch() {
  const calls: { url: string; method: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async (url: any, init?: any) => {
    calls.push({
      url: String(url),
      method: init?.method || 'GET',
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  const restore = () => { globalThis.fetch = originalFetch; };
  return { calls, restore };
}

describe('ClickUpClient.filterTeamTasks', () => {
  it('hits GET /team/{teamId}/task with no query string when no filters given', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/team/T1/task');
    } finally {
      restore();
    }
  });

  it('serializes assignees and statuses as repeated bare keys (no brackets)', async () => {
    // ClickUp v2 GET /team/{id}/task drops the filter silently if the PHP-style
    // `foo[]=` form is used. Repeated bare `foo=` is what actually filters.
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', {
        assignees: ['u1', 'u2'],
        statuses: ['open', 'in progress'],
      });
      const url = calls[0].url;
      assert.match(url, /(?:\?|&)assignees=u1(?:&|$)/);
      assert.match(url, /(?:\?|&)assignees=u2(?:&|$)/);
      assert.match(url, /(?:\?|&)statuses=open(?:&|$)/);
      assert.match(url, /(?:\?|&)statuses=in\+progress(?:&|$)/);
      assert.doesNotMatch(url, /%5B%5D/);
    } finally {
      restore();
    }
  });

  it('serializes tags, space_ids, project_ids, list_ids as bare repeated keys', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', {
        tags: ['frontend'],
        space_ids: ['s1'],
        project_ids: ['p1'],
        list_ids: ['l1', 'l2'],
      });
      const url = calls[0].url;
      assert.match(url, /(?:\?|&)tags=frontend(?:&|$)/);
      assert.match(url, /(?:\?|&)space_ids=s1(?:&|$)/);
      assert.match(url, /(?:\?|&)project_ids=p1(?:&|$)/);
      assert.match(url, /(?:\?|&)list_ids=l1(?:&|$)/);
      assert.match(url, /(?:\?|&)list_ids=l2(?:&|$)/);
      assert.doesNotMatch(url, /%5B%5D/);
    } finally {
      restore();
    }
  });

  it('serializes date filters as raw numeric values', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', {
        date_created_gt: 1700000000000,
        date_updated_gt: 1700000000001,
        due_date_lt: 1800000000000,
      });
      const url = calls[0].url;
      assert.match(url, /date_created_gt=1700000000000/);
      assert.match(url, /date_updated_gt=1700000000001/);
      assert.match(url, /due_date_lt=1800000000000/);
    } finally {
      restore();
    }
  });

  it('serializes boolean flags only when true', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', {
        reverse: false,
        subtasks: true,
        include_closed: true,
      });
      const url = calls[0].url;
      assert.doesNotMatch(url, /reverse=/);
      assert.match(url, /subtasks=true/);
      assert.match(url, /include_closed=true/);
    } finally {
      restore();
    }
  });

  it('serializes page and order_by', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', { page: 3, order_by: 'updated' });
      const url = calls[0].url;
      assert.match(url, /page=3/);
      assert.match(url, /order_by=updated/);
    } finally {
      restore();
    }
  });

  it('serializes page=0 explicitly (not skipped as falsy)', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', { page: 0 });
      assert.match(calls[0].url, /page=0/);
    } finally {
      restore();
    }
  });

  it('JSON-encodes custom_fields when non-empty', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', {
        custom_fields: [{ field_id: 'f1', operator: '=', value: 'x' }],
      });
      const url = new URL(calls[0].url);
      const raw = url.searchParams.get('custom_fields');
      assert.ok(raw);
      const parsed = JSON.parse(raw!);
      assert.deepEqual(parsed, [{ field_id: 'f1', operator: '=', value: 'x' }]);
    } finally {
      restore();
    }
  });

  it('does not include custom_fields when the array is empty', async () => {
    const { calls, restore } = withMockedFetch();
    try {
      const client = new ClickUpClient('tok');
      await client.filterTeamTasks('T1', { custom_fields: [] });
      assert.doesNotMatch(calls[0].url, /custom_fields=/);
    } finally {
      restore();
    }
  });

  it('sends bearer token in Authorization header', async () => {
    const { restore } = withMockedFetch();
    const spy = globalThis.fetch as any;
    try {
      const client = new ClickUpClient('tok-abc');
      await client.filterTeamTasks('T1');
      const init = spy.mock.calls[0].arguments[1];
      assert.equal(init.headers.Authorization, 'Bearer tok-abc');
    } finally {
      restore();
    }
  });
});
