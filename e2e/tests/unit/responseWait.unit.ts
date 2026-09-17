import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

// Tuned before the driver is imported: both are read at module load, and the
// real values (2.5s settle, 120s timeout) would make this file take minutes.
process.env.CLAUDE_SETTLE_MS = '20';
process.env.RESPONSE_TIMEOUT_MS = '3000';

const { waitForResponseComplete } = await import('../../drivers/claude-web.ts');

/** One poll's worth of page state. */
interface Frame {
  text: string;
  dialog: boolean;
}

/**
 * A page that replays a script, advancing one frame per waitForTimeout.
 *
 * waitForTimeout sleeps 5ms rather than the 500ms it is asked for, so the
 * settle window is reached in real time without the test taking a minute.
 */
function scriptedPage(frames: Frame[]): Page {
  let i = 0;
  const at = () => frames[Math.min(i, frames.length - 1)];

  return {
    locator(selector: string) {
      const isApproval = selector.includes('data-approval-digit');
      return {
        first: () => ({
          isVisible: async () => (isApproval ? at().dialog : at().text.length > 0),
          click: async () => {},
          innerText: async () => 'Always allow',
        }),
        count: async () => (isApproval ? 0 : at().text ? 1 : 0),
        nth: () => ({ innerText: async () => at().text }),
      };
    },
    waitForTimeout: async () => {
      i++;
      await new Promise((r) => setTimeout(r, 5));
    },
  } as unknown as Page;
}

const repeat = (frame: Frame, n: number): Frame[] => Array.from({ length: n }, () => ({ ...frame }));

test('returns the reply once its text stops changing', async () => {
  const page = scriptedPage([
    { text: '', dialog: false },
    ...repeat({ text: 'Found it: Needle', dialog: false }, 12),
  ]);
  assert.equal(await waitForResponseComplete(page), 'Found it: Needle');
});

// The regression. A preamble and the approval dialog can appear in the SAME
// gap between polls. If the post-approval baseline comes from the previous
// poll it is the older empty string, the next read differs from it, the guard
// clears itself, and the unchanged preamble satisfies the settle window --
// returning text from before the tool ran. Which is a wrong answer reported
// confidently, not a timeout.
test('does not settle on a preamble while the approved tool is still running', async () => {
  const page = scriptedPage([
    { text: '', dialog: false },
    { text: 'Let me search your Drive.', dialog: true },
    ...repeat({ text: 'Let me search your Drive.', dialog: false }, 10),
    ...repeat({ text: 'Let me search your Drive.\nFound it: Needle', dialog: false }, 12),
  ]);
  const reply = await waitForResponseComplete(page);
  assert.match(reply, /Found it: Needle/);
});

test('an approval mid-stream does not lose the finished answer', async () => {
  const page = scriptedPage([
    { text: 'Checking…', dialog: true },
    ...repeat({ text: 'Checking…', dialog: false }, 4),
    ...repeat({ text: 'Checking…\nBANANA-PHONE-7714', dialog: false }, 12),
  ]);
  assert.match(await waitForResponseComplete(page), /BANANA-PHONE-7714/);
});
