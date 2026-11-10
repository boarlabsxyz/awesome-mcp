import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  assertSlackUploadUrl, normalizeChannelName, performAddReaction, performEditCanvas, performScheduleMessage,
  performUpdateListItem, performUploadFile, resolvePostAt, toListCell, uploadBytes,
  editCanvasRestSchema, uploadFileRestSchema,
} from '../../slack/workspaceTools.js';
import { resolveDmUsers } from '../../slack/helpers.js';

// The ops run against a stub client: what is asserted is what would be sent to
// Slack and how its answers are reported. SLACK_WRITES_ENABLED gates them all.

const NOW = Date.parse('2026-11-10T12:00:00Z');
let previousGate: string | undefined;
beforeEach(() => { previousGate = process.env.SLACK_WRITES_ENABLED; process.env.SLACK_WRITES_ENABLED = 'true'; });
afterEach(() => { if (previousGate === undefined) delete process.env.SLACK_WRITES_ENABLED; else process.env.SLACK_WRITES_ENABLED = previousGate; });

describe('resolvePostAt', () => {
  it('accepts ISO and Unix times within 120 days', () => {
    assert.equal(resolvePostAt('2026-11-11T12:00:00Z', NOW), Date.parse('2026-11-11T12:00:00Z') / 1000);
    assert.equal(resolvePostAt(String(NOW / 1000 + 60), NOW), NOW / 1000 + 60);
  });
  it('refuses the past, more than 120 days ahead, and garbage', () => {
    assert.throws(() => resolvePostAt('2026-11-09T00:00:00Z', NOW), /in the past/);
    assert.throws(() => resolvePostAt('2027-04-01T00:00:00Z', NOW), /more than 120 days/);
    assert.throws(() => resolvePostAt('next tuesday', NOW), /neither an ISO/);
  });
});

describe('small validators', () => {
  it('normalizes a channel name and refuses spaces and periods', () => {
    assert.equal(normalizeChannelName('#Team-Updates'), 'team-updates');
    assert.throws(() => normalizeChannelName('team updates'), /not a valid Slack channel name/);
    assert.throws(() => normalizeChannelName('v1.2'), /not a valid/);
  });

  it('builds one typed cell per column and refuses zero or two values', () => {
    assert.deepEqual(toListCell({ columnId: 'C1', checkbox: true }), { column_id: 'C1', checkbox: true });
    assert.deepEqual(toListCell({ columnId: 'C2', text: 'Hi' }), {
      column_id: 'C2',
      rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Hi' }] }] }],
    });
    assert.deepEqual(toListCell({ columnId: 'C3', link: ['https://x.io'] }), { column_id: 'C3', link: [{ original_url: 'https://x.io' }] });
    assert.throws(() => toListCell({ columnId: 'C4' }), /exactly one value/);
    assert.throws(() => toListCell({ columnId: 'C5', text: 'a', checkbox: true }), /got 2/);
  });

  it('takes exactly one upload source and caps the size', () => {
    assert.equal(uploadBytes({ textContent: 'abc' }).length, 3);
    assert.throws(() => uploadBytes({}), /exactly one/);
    assert.throws(() => uploadBytes({ textContent: 'a', contentBase64: 'YQ==' }), /exactly one/);
    assert.throws(() => uploadBytes({ textContent: '' }), /empty/);
  });

  it('sends bytes only to Slack\'s upload host', () => {
    assert.equal(assertSlackUploadUrl('https://files.slack.com/upload/v1/abc').hostname, 'files.slack.com');
    assert.throws(() => assertSlackUploadUrl('https://evil.example/upload'), /unexpected host/);
    assert.throws(() => assertSlackUploadUrl('http://files.slack.com/x'), /unexpected host/);
  });

  it('opens a 1-on-1 or group DM, refusing both or neither', () => {
    assert.deepEqual(resolveDmUsers({ userId: 'U1' }), ['U1']);
    assert.deepEqual(resolveDmUsers({ userIds: ['U1', 'U2'] }), ['U1', 'U2']);
    assert.throws(() => resolveDmUsers({}), /not both or neither/);
    assert.throws(() => resolveDmUsers({ userId: 'U1', userIds: ['U2', 'U3'] }), /not both or neither/);
  });

  it('REST bodies refuse unknown keys', () => {
    assert.equal(uploadFileRestSchema.safeParse({ filename: 'a', textContent: 'x', channel_id: 'C1' }).success, false);
    assert.equal(editCanvasRestSchema.safeParse({ operation: 'insert_at_end', markdown: 'x' }).success, true);
  });
});

describe('ops', () => {
  it('refuses every write when SLACK_WRITES_ENABLED is off', async () => {
    process.env.SLACK_WRITES_ENABLED = 'false';
    await assert.rejects(() => performAddReaction({} as any, 'C1', { timestamp: '1.0', emoji: 'x' }), /disabled for this deployment/);
  });

  it('reports an existing reaction as already present, not as an error', async () => {
    const client = { reactionsAdd: mock.fn(async () => { throw new Error('Slack API error (reactions.add): already_reacted'); }) };
    const r = await performAddReaction(client as any, 'C1', { timestamp: '1.0', emoji: ':tada:' });
    assert.deepEqual(r, { emoji: 'tada', added: false, alreadyPresent: true });
    assert.deepEqual(client.reactionsAdd.mock.calls[0].arguments, ['C1', '1.0', 'tada']);
  });

  it('schedules with the resolved time and refuses a bad body before calling Slack', async () => {
    const client = { chatScheduleMessage: mock.fn(async (_c: string, postAt: number) => ({ scheduled_message_id: 'Q1', post_at: postAt, channel: 'C1' })) };
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await performScheduleMessage(client as any, 'C1', { postAt: at, markdownText: '- a' });
    assert.equal(r.scheduledMessageId, 'Q1');
    await assert.rejects(() => performScheduleMessage(client as any, 'C1', { postAt: at, text: 'x', markdownText: 'y' }), /either markdownText or text/);
    assert.equal(client.chatScheduleMessage.mock.callCount(), 1);
  });

  it('never replaces a whole canvas, and maps replace_section to a sectioned replace', async () => {
    const client = { canvasesEdit: mock.fn(async (_id: string, _change: unknown) => ({ ok: true })) };
    await assert.rejects(() => performEditCanvas(client as any, 'F1', { operation: 'replace_section', markdown: 'x' }), /needs sectionId/);
    await performEditCanvas(client as any, 'F1', { operation: 'replace_section', markdown: 'x', sectionId: 'temp:1' });
    assert.deepEqual(client.canvasesEdit.mock.calls[0].arguments[1], {
      operation: 'replace', document_content: { type: 'markdown', markdown: 'x' }, section_id: 'temp:1',
    });
  });

  it('confirms a list update from the re-read record', async () => {
    const client = {
      slackListsItemsUpdate: mock.fn(async (_id: string, _cells: unknown) => ({ ok: true })),
      slackListsItemsInfo: mock.fn(async () => ({ record: { fields: [{ column_id: 'Col1' }] } })),
    };
    const r = await performUpdateListItem(client as any, 'F1', 'Rec1', { fields: [{ columnId: 'Col1', checkbox: true }, { columnId: 'Col2', number: [3] }] });
    assert.deepEqual(client.slackListsItemsUpdate.mock.calls[0].arguments[1], [
      { row_id: 'Rec1', column_id: 'Col1', checkbox: true },
      { row_id: 'Rec1', column_id: 'Col2', number: [3] },
    ]);
    assert.equal(r.confirmed, false);
    assert.deepEqual(r.notReadBack, ['Col2']);
  });

  it('uploads through the external flow and reports sharing only as confirmed when Slack says so', async () => {
    const client = {
      filesGetUploadUrlExternal: mock.fn(async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F9' })),
      filesCompleteUploadExternal: mock.fn(async () => ({ files: [{ id: 'F9', channels: [] }] })),
    };
    const fetchImpl = mock.fn(async () => new Response('OK', { status: 200 }));
    const r = await performUploadFile(client as any, { filename: 'a.txt', textContent: 'hello', channelId: 'C1', title: 'A' }, fetchImpl as any);
    assert.deepEqual(client.filesGetUploadUrlExternal.mock.calls[0].arguments, ['a.txt', 5]);
    assert.deepEqual(client.filesCompleteUploadExternal.mock.calls[0].arguments, [[{ id: 'F9', title: 'A' }], { channelId: 'C1', threadTs: undefined, initialComment: undefined }]);
    assert.equal(r.sharedConfirmed, null, 'not yet visible is not "not shared"');
    await assert.rejects(() => performUploadFile(client as any, { filename: 'a', textContent: 'x', threadTs: '1.0' }, fetchImpl as any), /threadTs needs channelId/);
  });

  it('does not complete an upload whose bytes failed to transfer', async () => {
    const client = {
      filesGetUploadUrlExternal: mock.fn(async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F9' })),
      filesCompleteUploadExternal: mock.fn(async () => ({ files: [] })),
    };
    const fetchImpl = mock.fn(async () => new Response('nope', { status: 500 }));
    await assert.rejects(() => performUploadFile(client as any, { filename: 'a', textContent: 'x' }, fetchImpl as any), /HTTP 500/);
    assert.equal(client.filesCompleteUploadExternal.mock.callCount(), 0);
  });
});
