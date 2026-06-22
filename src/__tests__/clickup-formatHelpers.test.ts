import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatTask,
  formatTaskList,
  formatCustomFieldValue,
} from '../clickup/formatHelpers.js';

describe('clickup formatHelpers', () => {
  describe('formatCustomFieldValue', () => {
    it('returns "[empty]" for null', () => {
      assert.equal(formatCustomFieldValue({ value: null }), '[empty]');
    });

    it('returns "[empty]" for undefined', () => {
      assert.equal(formatCustomFieldValue({ value: undefined }), '[empty]');
    });

    it('renders drop_down using type_config option labels', () => {
      const cf = {
        type: 'drop_down',
        value: '1',
        type_config: { options: [{ orderindex: 1, id: 'opt-1', name: 'High' }] },
      };
      assert.equal(formatCustomFieldValue(cf), 'High (id: opt-1)');
    });

    it('renders labels as comma-separated label strings', () => {
      const cf = {
        type: 'labels',
        value: ['uuid-a', 'uuid-b'],
        type_config: { options: [{ id: 'uuid-a', label: 'Bug' }, { id: 'uuid-b', label: 'Frontend' }] },
      };
      assert.equal(formatCustomFieldValue(cf), 'Bug, Frontend');
    });

    it('renders users by username/email/id fallback', () => {
      const cf = { type: 'users', value: [{ username: 'alice' }, { email: 'b@c' }, { id: 9 }] };
      assert.equal(formatCustomFieldValue(cf), 'alice, b@c, 9');
    });

    it('stringifies an unknown object value', () => {
      assert.equal(formatCustomFieldValue({ type: 'unknown', value: { x: 1 } }), '{"x":1}');
    });

    it('returns primitive value as a string', () => {
      assert.equal(formatCustomFieldValue({ type: 'short_text', value: 'hi' }), 'hi');
      assert.equal(formatCustomFieldValue({ type: 'number', value: 7 }), '7');
    });
  });

  describe('formatTask', () => {
    it('renders the minimal required fields', () => {
      const out = formatTask({ id: 't1', name: 'Do thing', status: { status: 'open' } });
      assert.ok(out.includes('Task: Do thing'));
      assert.ok(out.includes('ID: t1'));
      assert.ok(out.includes('Status: open'));
    });

    it('renders all optional fields when present', () => {
      const out = formatTask({
        id: 't2',
        name: 'Big',
        status: { status: 'closed' },
        priority: { priority: 'urgent' },
        assignees: [{ username: 'alice' }, { email: 'b@c' }],
        due_date: '1700000000000',
        description: 'a'.repeat(250),
        url: 'https://example/t2',
        list: { id: 'l1', name: 'Main' },
        tags: [{ name: 'frontend' }, { name: 'bug' }],
        custom_fields: [
          { name: 'estimate', value: 4 },
          { name: 'skipped', value: null },
        ],
      });
      assert.ok(out.includes('Priority: urgent'));
      assert.ok(out.includes('Assignees: alice, b@c'));
      assert.ok(out.includes('Due: 20'));
      assert.ok(out.includes('...'));
      assert.ok(out.includes('URL: https://example/t2'));
      assert.ok(out.includes('List: Main (l1)'));
      assert.ok(out.includes('Tags: frontend, bug'));
      assert.ok(out.includes('Custom Fields:'));
      assert.ok(out.includes('estimate: 4'));
      assert.ok(!out.includes('skipped'));
    });

    it('omits "Custom Fields:" header when all values are null', () => {
      const out = formatTask({
        id: 't',
        name: 'x',
        status: { status: 'open' },
        custom_fields: [{ name: 'a', value: null }],
      });
      assert.ok(!out.includes('Custom Fields:'));
    });
  });

  describe('formatTaskList', () => {
    it('returns "No tasks found." for empty input', () => {
      assert.equal(formatTaskList([]), 'No tasks found.');
    });

    it('joins multiple tasks with blank lines', () => {
      const out = formatTaskList([
        { id: 'a', name: 'A', status: { status: 'open' } },
        { id: 'b', name: 'B', status: { status: 'open' } },
      ]);
      assert.ok(out.includes('Task: A'));
      assert.ok(out.includes('Task: B'));
      assert.ok(out.includes('\n\n'));
    });
  });
});
