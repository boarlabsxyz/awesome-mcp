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
      // List preview (default): bounded to 200 chars, but discloses the true
      // length so the caller knows text was dropped and can fetch the rest.
      assert.ok(out.includes('showing 200 of 250 chars'));
      assert.ok(out.includes('call getTask for the full description'));
      assert.ok(!out.includes('a'.repeat(201)));
      assert.ok(out.includes('URL: https://example/t2'));
      assert.ok(out.includes('List: Main (l1)'));
      assert.ok(out.includes('Tags: frontend, bug'));
      assert.ok(out.includes('Custom Fields:'));
      assert.ok(out.includes('estimate: 4'));
      assert.ok(!out.includes('skipped'));
    });

    it('names Milestone and shows other task types by ID', () => {
      assert.ok(formatTask({ id: 't1', name: 'M', status: { status: 'open' }, custom_item_id: 1 })
        .includes('Task type: Milestone (1)'));
      assert.ok(formatTask({ id: 't2', name: 'B', status: { status: 'open' }, custom_item_id: 1300 })
        .includes('Task type: 1300'));
    });

    it('stays quiet about task type for a plain Task (0) or when absent', () => {
      assert.ok(!formatTask({ id: 't1', name: 'P', status: { status: 'open' }, custom_item_id: 0 }).includes('Task type'));
      assert.ok(!formatTask({ id: 't2', name: 'P', status: { status: 'open' } }).includes('Task type'));
    });

    it('flags an archived task', () => {
      const out = formatTask({ id: 't1', name: 'Old', status: { status: 'open' }, archived: true });
      assert.ok(out.includes('Archived: yes'));
    });

    it('stays quiet about archived for a live task', () => {
      const out = formatTask({ id: 't1', name: 'Live', status: { status: 'open' }, archived: false });
      assert.ok(!out.includes('Archived'));
    });

    // Parent / top_level_parent are how a hierarchy gets rebuilt from a list
    // rendering without one getTask per node. ClickUp ships them as bare IDs.
    it('renders Parent when the task is a subtask', () => {
      const out = formatTask({ id: 't1', name: 'Child', status: { status: 'open' }, parent: 'p1' });
      assert.ok(out.includes('Parent: p1'));
    });

    it('omits Parent for a top-level task', () => {
      const out = formatTask({ id: 't1', name: 'Root', status: { status: 'open' }, parent: null });
      assert.ok(!out.includes('Parent'));
    });

    it('suppresses Top-level parent when it just repeats parent', () => {
      const out = formatTask({ id: 't1', name: 'Child', status: { status: 'open' }, parent: 'p1', top_level_parent: 'p1' });
      assert.ok(out.includes('Parent: p1'));
      assert.ok(!out.includes('Top-level parent'));
    });

    it("suppresses Top-level parent when it is the task's own id", () => {
      const out = formatTask({ id: 't1', name: 'Root', status: { status: 'open' }, top_level_parent: 't1' });
      assert.ok(!out.includes('Top-level parent'));
    });

    it('renders Top-level parent only when nesting is deeper than one level', () => {
      const out = formatTask({ id: 't1', name: 'Grandchild', status: { status: 'open' }, parent: 'mid', top_level_parent: 'root' });
      assert.ok(out.includes('Parent: mid'));
      assert.ok(out.includes('Top-level parent: root'));
    });

    it('returns the full, untruncated description with { fullDescription: true }', () => {
      const desc = 'a'.repeat(250);
      const out = formatTask(
        { id: 't3', name: 'Full', status: { status: 'open' }, description: desc },
        { fullDescription: true },
      );
      assert.ok(out.includes(`Description: ${desc}`));
      assert.ok(!out.includes('truncated'));
      assert.ok(!out.includes('showing 200'));
    });

    it('does not truncate a short description in preview mode', () => {
      const out = formatTask({ id: 't4', name: 'Short', status: { status: 'open' }, description: 'hello' });
      assert.ok(out.includes('Description: hello'));
      assert.ok(!out.includes('truncated'));
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

    // The point of surfacing parent in the list rendering: the child's parent
    // ID is matched against IDs already in the same response, so building a
    // tree costs zero extra calls.
    it('surfaces parent IDs so a hierarchy can be rebuilt from one call', () => {
      const out = formatTaskList([
        { id: 'root', name: 'CSF', status: { status: 'open' } },
        { id: 'kid', name: 'Hypothesis', status: { status: 'open' }, parent: 'root' },
      ]);
      assert.ok(out.includes('ID: root'));
      assert.ok(out.includes('Parent: root'));
    });
  });
});
