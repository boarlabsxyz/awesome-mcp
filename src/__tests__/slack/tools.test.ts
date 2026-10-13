import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Registry-level tests for the slack-BOT server.
//
// src/__tests__/slack/server.test.ts drives SlackClient directly and never
// imports the server module, so until this file nothing checked the bot
// server's registrations at all: a duplicate tool name, a missing
// .describe() or a tool that was never registered shipped silently. The
// slack-user side has had this guard (slack-user/tools.test.ts) — this is its
// counterpart, added because `editMessage` is now registered here too and
// "the handler exists but no server registers it" is exactly the state that
// made the tool unreachable before.
//
// Same addTool-patching trick as slack-user/tools.test.ts and
// clickup/server.test.ts: patch the prototype before importing the server so
// every registration is captured.
// ---------------------------------------------------------------------------

const registrations: any[] = [];

const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  registrations.push(tool);
  return origAddTool.call(this, tool);
};

await import('../../slack/server.js');

FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const toolMap = new Map<string, any>(registrations.map(t => [t.name, t]));

const WRITE_TOOLS = ['postMessage', 'replyInThread', 'editMessage'];

describe('slack-bot tool registry', () => {
  it('registers every tool name exactly once', () => {
    assert.equal(registrations.length, toolMap.size, 'duplicate tool name registered');
  });

  it('registers the 8 original tools, editMessage and 2 shared tools', () => {
    const expected = [
      'listChannels', 'readChannelHistory', 'readThreadReplies', 'downloadFile',
      'postMessage', 'replyInThread', 'editMessage', 'listUsers', 'openDm',
      'mintRestBearerForCurl', 'listRestEndpoints',
    ];
    assert.deepEqual([...toolMap.keys()].sort(), expected.sort());
  });

  it('marks reads read-only and writes not', () => {
    for (const name of ['listChannels', 'readChannelHistory', 'readThreadReplies', 'listUsers']) {
      assert.equal(toolMap.get(name).annotations.readOnlyHint, true, `${name} should be read-only`);
    }
    for (const name of WRITE_TOOLS) {
      assert.equal(toolMap.get(name).annotations.readOnlyHint, false, `${name} should not be read-only`);
    }
  });

  it('marks editMessage a plain write, not destructive', () => {
    // Matches the slack-user copy and every other in-place update in the repo
    // (updateCompany, editPage, writeSpreadsheet). destructiveHint is reserved
    // for deletes.
    const annotations = toolMap.get('editMessage').annotations;
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, undefined);
  });

  it('requires channelId and ts to edit, and nothing more', () => {
    // `text` is optional: markdownText or blocks can carry the content, and
    // markdownText cannot be combined with text at all. The combinations are
    // enforced by resolveMessageBody, not Zod — see its doc comment.
    const parameters = toolMap.get('editMessage').parameters;
    assert.throws(() => parameters.parse({}), /channelId/i);
    assert.throws(() => parameters.parse({ channelId: 'C1' }), /ts/i);
    assert.deepEqual(parameters.parse({ channelId: 'C1', ts: '1.0' }), { channelId: 'C1', ts: '1.0' });
  });

  it('describes every parameter of every tool', () => {
    // The LLM fills arguments from these descriptions; a missing one silently
    // degrades tool-call quality.
    for (const [name, tool] of toolMap) {
      const shape = tool.parameters?.shape;
      if (!shape) continue;
      for (const [param, schema] of Object.entries<any>(shape)) {
        assert.ok(schema.description, `${name}.${param} has no .describe()`);
      }
    }
  });

  it('offers markdownText, blocks and broadcast where each belongs', () => {
    // The reported gap: Slack mrkdwn has no list syntax, so text alone cannot
    // express a list. broadcast belongs only to replyInThread — there is
    // nothing to broadcast on a top-level post, and chat.update's
    // reply_broadcast is unverified here.
    for (const name of WRITE_TOOLS) {
      const shape = toolMap.get(name).parameters.shape;
      assert.ok(shape.markdownText, `${name} should accept markdownText`);
      assert.ok(shape.blocks, `${name} should accept blocks`);
      assert.ok(shape.text.isOptional(), `${name}.text should be optional`);
    }
    assert.ok(toolMap.get('replyInThread').parameters.shape.broadcast);
    assert.equal(toolMap.get('postMessage').parameters.shape.broadcast, undefined);
    assert.equal(toolMap.get('editMessage').parameters.shape.broadcast, undefined);
  });

  it('keeps the unfurl flags off editMessage', () => {
    // Deliberate and pre-existing: whether chat.update strips an unfurl
    // already rendered in the channel is unverified, and a parameter that
    // silently does nothing is worse than no parameter. Adding blocks did not
    // reverse that — blocks is a documented first-class chat.update argument
    // with an echo to check against.
    const shape = toolMap.get('editMessage').parameters.shape;
    assert.equal(shape.unfurlLinks, undefined);
    assert.equal(shape.unfurlMedia, undefined);
  });
});
