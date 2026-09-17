import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvePendingToolUse } from '../../drivers/claude-web.ts';
import type { Page } from 'playwright';

// The tool-approval dialog halts the turn, and nothing downstream can tell that
// apart from a slow reply. So the one thing this helper must never do is report
// success when the dialog is still up: that turns a blocked turn into a response
// timeout blaming the reply, which is precisely the misdirection it exists to
// remove.

function fakePage(opts: {
  visible: boolean[];
  clickError?: Error;
}): { page: Page; clicks: number } {
  const state = { clicks: 0, visibleCalls: 0 };
  const locator = {
    first: () => locator,
    async isVisible() {
      const i = Math.min(state.visibleCalls++, opts.visible.length - 1);
      return opts.visible[i];
    },
    async click() {
      state.clicks++;
      if (opts.clickError) throw opts.clickError;
    },
  };
  return {
    page: { locator: () => locator } as unknown as Page,
    get clicks() {
      return state.clicks;
    },
  };
}

test('no dialog on screen is not an approval', async () => {
  const f = fakePage({ visible: [false] });
  assert.equal(await approvePendingToolUse(f.page), false);
  assert.equal(f.clicks, 0);
});

test('a visible dialog is clicked and reported as approved', async () => {
  const f = fakePage({ visible: [true] });
  assert.equal(await approvePendingToolUse(f.page), true);
  assert.equal(f.clicks, 1);
});

// The benign race: something answered the dialog between the check and the
// click, so the control detached and there is nothing left to approve.
test('a click that fails on a vanished dialog reports no approval', async () => {
  const f = fakePage({
    visible: [true, false],
    clickError: new Error('element is not attached to the DOM'),
  });
  assert.equal(await approvePendingToolUse(f.page), false);
});

// The case that matters: the click failed and the dialog is STILL THERE.
// Returning true here would let the loop wait out its whole timeout on a turn
// that never resumed, and report it as a missing reply.
test('a click that fails with the dialog still up throws', async () => {
  const f = fakePage({
    visible: [true, true],
    clickError: new Error('element intercepts pointer events'),
  });
  await assert.rejects(() => approvePendingToolUse(f.page), /intercepts pointer events/);
});
