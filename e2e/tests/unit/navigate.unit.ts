import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gotoTolerantly } from '../../drivers/navigate.ts';
import type { Page } from 'playwright';

// A fake Page is enough: the whole contract is which errors are swallowed.
function fakePage(gotoError?: Error) {
  const calls: string[] = [];
  return {
    calls,
    page: {
      async goto(url: string) {
        calls.push(`goto:${url}`);
        if (gotoError) throw gotoError;
        return null;
      },
      async waitForLoadState() {
        calls.push('waitForLoadState');
      },
    } as unknown as Page,
  };
}

test('a clean navigation just navigates', async () => {
  const { page, calls } = fakePage();
  await gotoTolerantly(page, 'https://claude.ai/new');
  assert.deepEqual(calls, ['goto:https://claude.ai/new']);
});

// The failure that started this: claude.ai rewrites the route client-side, so
// the navigation we asked for is superseded and Chrome reports ERR_ABORTED.
// Treating that as fatal failed the run before a single selector was tried.
test('a superseded navigation is tolerated and settled', async () => {
  const { page, calls } = fakePage(
    new Error('page.goto: net::ERR_ABORTED at https://claude.ai/new'),
  );
  await gotoTolerantly(page, 'https://claude.ai/new');
  assert.deepEqual(calls, ['goto:https://claude.ai/new', 'waitForLoadState']);
});

test('a real navigation failure still throws', async () => {
  const { page } = fakePage(new Error('page.goto: net::ERR_CONNECTION_REFUSED'));
  await assert.rejects(
    () => gotoTolerantly(page, 'https://claude.ai/new'),
    /ERR_CONNECTION_REFUSED/,
  );
});

test('a DNS failure still throws', async () => {
  const { page } = fakePage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED'));
  await assert.rejects(() => gotoTolerantly(page, 'https://nope.invalid'), /ERR_NAME_NOT_RESOLVED/);
});
