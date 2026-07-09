import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CAPTURED_EVENTS,
  parseClickUpWebhookPayload,
  verifyClickUpSignature,
} from '../clickup/webhookHelpers.js';

// Build the exact signature ClickUp would send for a body + secret pair, so
// tests exercise the verify path with known-good inputs.
function sign(secret: string, body: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('CAPTURED_EVENTS', () => {
  it('matches the recommended bundle from the design review', () => {
    assert.deepEqual(
      [...CAPTURED_EVENTS].sort(),
      ['taskAssigneeUpdated', 'taskCreated', 'taskDeleted', 'taskMoved', 'taskStatusUpdated'],
    );
  });

  it('deliberately does not include taskUpdated', () => {
    assert.equal(CAPTURED_EVENTS.includes('taskUpdated' as any), false);
  });
});

describe('verifyClickUpSignature', () => {
  const secret = 'sh4red-s3cret';
  const body = '{"webhook_id":"w1","event":"taskStatusUpdated"}';

  it('accepts a valid signature over a string body', () => {
    const sig = sign(secret, body);
    assert.equal(verifyClickUpSignature(secret, body, sig), true);
  });

  it('accepts a valid signature over a Buffer body', () => {
    const buf = Buffer.from(body);
    const sig = sign(secret, buf);
    assert.equal(verifyClickUpSignature(secret, buf, sig), true);
  });

  it('rejects a wrong signature', () => {
    assert.equal(verifyClickUpSignature(secret, body, sign('other-secret', body)), false);
  });

  it('rejects a mutated body', () => {
    const sig = sign(secret, body);
    assert.equal(verifyClickUpSignature(secret, body + ' ', sig), false);
  });

  it('rejects a missing/empty signature', () => {
    assert.equal(verifyClickUpSignature(secret, body, ''), false);
  });

  it('rejects a signature of wrong length without throwing', () => {
    assert.equal(verifyClickUpSignature(secret, body, 'abc'), false);
  });

  it('rejects non-hex garbage without throwing', () => {
    // 64 chars but not hex — timingSafeEqual would throw; the helper catches it.
    const notHex = 'z'.repeat(64);
    assert.equal(verifyClickUpSignature(secret, body, notHex), false);
  });
});

describe('parseClickUpWebhookPayload', () => {
  const sub = { id: 42, workspaceId: 'W1' };

  it('emits one row per history_item and preserves subscription context', () => {
    const rows = parseClickUpWebhookPayload({
      webhook_id: 'w1',
      event: 'taskStatusUpdated',
      task_id: 'T1',
      history_items: [
        {
          field: 'status',
          date: '1700000000000',
          user: { id: 7, username: 'alice' },
          before: { status: 'in progress' },
          after: { status: 'closed' },
        },
        {
          field: 'assignee',
          date: 1700000000001,
          user: { id: 8, username: 'bob' },
          before: { username: 'carol' },
          after: { username: 'dave' },
        },
      ],
    }, sub);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].subscriptionId, 42);
    assert.equal(rows[0].workspaceId, 'W1');
    assert.equal(rows[0].taskId, 'T1');
    assert.equal(rows[0].eventType, 'taskStatusUpdated');
    assert.equal(rows[0].field, 'status');
    assert.equal(rows[0].fromVal, 'in progress');
    assert.equal(rows[0].toVal, 'closed');
    assert.equal(rows[0].actorId, '7');
    assert.equal(rows[0].actorUsername, 'alice');
    assert.equal(rows[0].occurredAt, 1700000000000);
    assert.equal(rows[1].field, 'assignee');
    assert.equal(rows[1].fromVal, 'carol');
    assert.equal(rows[1].toVal, 'dave');
    assert.equal(rows[1].occurredAt, 1700000000001);
  });

  it('emits a single placeholder row when history_items is missing', () => {
    const rows = parseClickUpWebhookPayload({
      webhook_id: 'w1',
      event: 'taskDeleted',
      task_id: 'T2',
    }, sub);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, 'taskDeleted');
    assert.equal(rows[0].field, null);
    assert.equal(rows[0].fromVal, null);
    assert.equal(rows[0].toVal, null);
    assert.equal(rows[0].taskId, 'T2');
  });

  it('emits a single placeholder row when history_items is an empty array', () => {
    const rows = parseClickUpWebhookPayload({
      event: 'taskCreated',
      task_id: 'T3',
      history_items: [],
    }, sub);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, 'taskCreated');
  });

  it('serializes non-primitive before/after via JSON when no known key', () => {
    const rows = parseClickUpWebhookPayload({
      event: 'taskMoved',
      task_id: 'T4',
      history_items: [{
        field: 'parent',
        date: '1700000000000',
        before: { list_id: 'L1', label: 'old' },
        after: { list_id: 'L2', label: 'new' },
      }],
    }, sub);
    assert.equal(rows[0].fromVal, JSON.stringify({ list_id: 'L1', label: 'old' }));
    assert.equal(rows[0].toVal, JSON.stringify({ list_id: 'L2', label: 'new' }));
  });

  it('handles missing user field without throwing', () => {
    const rows = parseClickUpWebhookPayload({
      event: 'taskStatusUpdated',
      task_id: 'T5',
      history_items: [{ field: 'status', date: 1700000000000, before: 'a', after: 'b' }],
    }, sub);
    assert.equal(rows[0].actorId, null);
    assert.equal(rows[0].actorUsername, null);
  });

  it('falls back to Date.now for non-numeric date', () => {
    const before = Date.now();
    const rows = parseClickUpWebhookPayload({
      event: 'taskCreated',
      task_id: 'T6',
      history_items: [{ field: 'x', date: 'not-a-number', before: 'a', after: 'b' }],
    }, sub);
    const after = Date.now();
    assert.ok(rows[0].occurredAt >= before && rows[0].occurredAt <= after);
  });

  it('coerces string ids to strings when a numeric ID would work too', () => {
    const rows = parseClickUpWebhookPayload({
      event: 'taskStatusUpdated',
      task_id: 12345,
      history_items: [{
        field: 'status',
        date: 1700000000000,
        user: { id: 99, username: 'x' },
        before: { status: 'a' },
        after: { status: 'b' },
      }],
    }, sub);
    assert.equal(typeof rows[0].taskId, 'string');
    assert.equal(rows[0].taskId, '12345');
    assert.equal(rows[0].actorId, '99');
  });
});
