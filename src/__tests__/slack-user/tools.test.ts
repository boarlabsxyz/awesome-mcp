import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Registry-level tests for the slack-user server. Nothing else imports this
// module, so before this file a syntax error, a duplicate tool name or a wrong
// annotation shipped silently. Same addTool-patching trick as
// src/__tests__/clickup/server.test.ts: patch the prototype before importing
// the server so every registration is captured.
//
// The execute bodies of the event tools can't be driven here — they dynamically
// import eventStore, which hard-requires Postgres — so this covers the parts
// that are checkable without a database: registration, annotations, and the
// Zod schemas. Behaviour lives in the flow tests (slack-eventFlows) and the
// handler tests (slack/helpers-extended).
// ---------------------------------------------------------------------------

const registrations: any[] = [];

const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  registrations.push(tool);
  return origAddTool.call(this, tool);
};

await import('../../slack-user/server.js');

FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const toolMap = new Map<string, any>(registrations.map(t => [t.name, t]));

const SEARCH_TOOLS = ['searchMessages', 'searchFiles'];
const EVENT_TOOLS = [
  'subscribeToChannelEvents',
  'listChannelEventSubscriptions',
  'getChannelEventHistory',
  'debugChannelEventSubscription',
  'unsubscribeFromChannelEvents',
];

describe('slack-user tool registry', () => {
  it('registers every tool name exactly once', () => {
    // A duplicate name compiles fine and the second registration wins, leaving
    // the first as dead code — worth failing loudly on.
    assert.equal(registrations.length, toolMap.size, 'duplicate tool name registered');
  });

  it('registers the 8 original tools, editMessage, diagnoseChannelAccess, 2 search tools, 5 event tools and 2 shared tools', () => {
    const expected = [
      'listChannels', 'readChannelHistory', 'readThreadReplies', 'downloadFile',
      'postMessage', 'replyInThread', 'editMessage', 'listUsers', 'openDm',
      'diagnoseChannelAccess',
      ...SEARCH_TOOLS,
      ...EVENT_TOOLS,
      'mintRestBearerForCurl', 'listRestEndpoints',
    ];
    assert.deepEqual([...toolMap.keys()].sort(), expected.sort());
  });

  it('marks reads read-only and writes not', () => {
    for (const name of ['searchMessages', 'searchFiles', 'listChannelEventSubscriptions', 'getChannelEventHistory', 'debugChannelEventSubscription', 'diagnoseChannelAccess']) {
      assert.equal(toolMap.get(name).annotations.readOnlyHint, true, `${name} should be read-only`);
    }
    assert.equal(toolMap.get('subscribeToChannelEvents').annotations.readOnlyHint, false);
  });

  it('marks editMessage a plain write, not destructive', () => {
    // Matches every other in-place update in the repo (updateCompany, editPage,
    // writeSpreadsheet). destructiveHint is reserved for deletes; marking an
    // edit destructive would needlessly uncheck it on the readonly connector.
    const annotations = toolMap.get('editMessage').annotations;
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, undefined);
  });

  it('requires channelId, ts and text to edit, and describes each', () => {
    const parameters = toolMap.get('editMessage').parameters;
    assert.throws(() => parameters.parse({}), /channelId/i);
    assert.throws(() => parameters.parse({ channelId: 'C1' }), /ts/i);
    assert.throws(() => parameters.parse({ channelId: 'C1', ts: '1.0' }), /text/i);
    assert.deepEqual(
      parameters.parse({ channelId: 'C1', ts: '1.0', text: 'x' }),
      { channelId: 'C1', ts: '1.0', text: 'x' },
    );
    for (const [param, schema] of Object.entries<any>(parameters.shape)) {
      assert.ok(schema.description, `editMessage.${param} has no .describe()`);
    }
  });

  it('marks unsubscribe destructive, because it discards captured history', () => {
    const annotations = toolMap.get('unsubscribeFromChannelEvents').annotations;
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
  });

  it('describes every parameter of every new tool', () => {
    // The LLM fills arguments from these descriptions; a missing one silently
    // degrades tool-call quality.
    for (const name of [...SEARCH_TOOLS, ...EVENT_TOOLS]) {
      const shape = toolMap.get(name).parameters.shape;
      for (const [param, schema] of Object.entries<any>(shape)) {
        assert.ok(schema.description, `${name}.${param} has no .describe()`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Access-gating guard.
//
// claude.md states that this server "wraps every channel-scoped tool in
// enforceAccess", and the access rules are only worth anything if that is
// true — a tool that takes a channelId and skips the check reads and writes
// channels the user has explicitly denied. Nothing asserted it until now, so a
// new channel-scoped tool could ship ungated and no test would notice.
//
// A static source scan, for the same reason sharedToolsRegistration.test.ts
// uses one: what is being guarded IS the presence of a call in the source, and
// driving these execute bodies for real needs a Slack token and a database.
// ---------------------------------------------------------------------------
const serverSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../slack-user/server.ts'),
  'utf8',
);

/** Source text of one addTool({...}) block, found by brace matching. */
function toolSource(name: string): string {
  const start = serverSource.indexOf(`name: '${name}'`);
  assert.ok(start > 0, `${name} not found in server source`);
  const open = serverSource.lastIndexOf('addTool({', start);
  assert.ok(open > 0, `${name} is not inside an addTool call`);
  let depth = 0;
  for (let i = open + 'addTool('.length; i < serverSource.length; i++) {
    const ch = serverSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return serverSource.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated addTool block for ${name}`);
}

/**
 * Tools that take a channelId but deliberately do not call enforceAccess.
 * Each needs a reason, because the default must be "it is gated".
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // Its whole purpose is to *report* the rule verdict, including a denial, so
  // it evaluates assertAccess itself and formats the explanation instead of
  // throwing. Gating it would make the diagnostic unusable exactly when the
  // user needs it.
  diagnoseChannelAccess: 'reports the verdict instead of enforcing it',
  // Lists only rows this user created, and no channel content -- the channel
  // ID in the output is one they supplied when subscribing.
  listChannelEventSubscriptions: 'lists only the caller\'s own subscription rows',
  // Explicitly ungated in server.ts, and gating it would be actively harmful:
  // a user whose channel access was revoked after subscribing could never
  // clean the subscription up.
  unsubscribeFromChannelEvents: 'deleting your own subscription reads no channel content',
};

describe('slack-user access gating', () => {
  it('runs enforceAccess in every tool that takes a channelId', () => {
    const offenders: string[] = [];
    for (const [name, tool] of toolMap) {
      const shape = tool.parameters?.shape;
      if (!shape || !('channelId' in shape)) continue;
      if (name in UNGATED_BY_DESIGN) continue;
      if (!toolSource(name).includes('enforceAccess(')) offenders.push(name);
    }
    assert.deepEqual(
      offenders, [],
      `channel-scoped tool(s) missing enforceAccess: ${offenders.join(', ')}. ` +
      'Add the call, or add an entry to UNGATED_BY_DESIGN with the reason.',
    );
  });

  it('gates the write tools specifically', () => {
    // Spelled out separately: a write that skips the check does not just leak,
    // it mutates a channel the user denied.
    for (const name of ['postMessage', 'replyInThread', 'editMessage']) {
      assert.ok(
        toolSource(name).includes('enforceAccess('),
        `${name} must call enforceAccess`,
      );
    }
  });

  it('keeps every UNGATED_BY_DESIGN entry real', () => {
    // Stops the exception list rotting into a place where a gap hides.
    for (const name of Object.keys(UNGATED_BY_DESIGN)) {
      assert.ok(toolMap.has(name), `${name} is exempted but no longer registered`);
    }
  });
});

describe('slack-user search tool schemas', () => {
  it('requires a query and defaults count to 20', () => {
    for (const name of SEARCH_TOOLS) {
      const parameters = toolMap.get(name).parameters;
      assert.throws(() => parameters.parse({}), /query/i, `${name} should require query`);
      assert.equal(parameters.parse({ query: 'x' }).count, 20);
    }
  });

  it('accepts the documented sort values and rejects others', () => {
    const parameters = toolMap.get('searchMessages').parameters;
    assert.equal(parameters.parse({ query: 'x', sort: 'timestamp' }).sort, 'timestamp');
    assert.equal(parameters.parse({ query: 'x', sortDir: 'asc' }).sortDir, 'asc');
    assert.throws(() => parameters.parse({ query: 'x', sort: 'relevance' }));
  });

  it('leaves page unset so the client applies Slack\'s default', () => {
    assert.equal(toolMap.get('searchMessages').parameters.parse({ query: 'x' }).page, undefined);
  });
});

describe('slack-user event tool schemas', () => {
  it('requires a channelId to subscribe and leaves events optional', () => {
    const parameters = toolMap.get('subscribeToChannelEvents').parameters;
    assert.throws(() => parameters.parse({}), /channelId/i);
    const parsed = parameters.parse({ channelId: 'C1' });
    assert.equal(parsed.events, undefined, 'omitted events means "capture the default bundle"');
    assert.equal(parsed.matchPattern, undefined);
  });

  it('accepts only the event names the store actually records', () => {
    const parameters = toolMap.get('subscribeToChannelEvents').parameters;
    assert.deepEqual(parameters.parse({ channelId: 'C1', events: ['message', 'reaction_added'] }).events, ['message', 'reaction_added']);
    // Subscription names (message.channels) are not event names — accepting
    // them would store rows nothing could ever match.
    assert.throws(() => parameters.parse({ channelId: 'C1', events: ['message.channels'] }));
    // app_mention is bot-token territory and deliberately unavailable here.
    assert.throws(() => parameters.parse({ channelId: 'C1', events: ['app_mention'] }));
  });

  it('bounds the history limit to the store\'s cap', () => {
    const parameters = toolMap.get('getChannelEventHistory').parameters;
    assert.equal(parameters.parse({ channelId: 'C1', limit: 2000 }).limit, 2000);
    assert.throws(() => parameters.parse({ channelId: 'C1', limit: 2001 }));
    assert.throws(() => parameters.parse({ channelId: 'C1', limit: 0 }));
    assert.throws(() => parameters.parse({ channelId: 'C1', limit: 1.5 }));
  });

  it('takes since/until as strings so ISO and Unix-ms both work', () => {
    const parameters = toolMap.get('getChannelEventHistory').parameters;
    assert.equal(parameters.parse({ channelId: 'C1', since: '1760000000000' }).since, '1760000000000');
    assert.equal(parameters.parse({ channelId: 'C1', since: '2026-08-01T00:00:00Z' }).since, '2026-08-01T00:00:00Z');
  });

  it('makes the subscription-narrowing channelId optional when listing', () => {
    assert.deepEqual(toolMap.get('listChannelEventSubscriptions').parameters.parse({}), {});
  });
});

describe('slack-user event tools require a logged-in user', () => {
  // Every event tool keys on session.userId (subscriptions are per user), so
  // each must fail clearly rather than writing a row owned by nobody.
  const noSession = { session: undefined, log: { info: () => {}, error: () => {}, warn: () => {} } };

  for (const name of EVENT_TOOLS) {
    it(`${name} rejects a call with no user context`, async () => {
      await assert.rejects(
        () => toolMap.get(name).execute({ channelId: 'C1' }, noSession),
        /requires a logged-in user context/,
        `${name} should refuse to act without session.userId`,
      );
    });
  }

  it('search tools surface the not-connected error instead', async () => {
    for (const name of SEARCH_TOOLS) {
      await assert.rejects(
        () => toolMap.get(name).execute({ query: 'x', count: 20 }, noSession),
        /Slack not connected/,
      );
    }
  });
});
