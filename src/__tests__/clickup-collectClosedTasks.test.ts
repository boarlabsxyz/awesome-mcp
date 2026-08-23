import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectTasksInCloseWindow } from '../clickup/apiHelpers.js';

// Builds a fake ClickUp task with just the fields the filter reads.
function task(id: string, closedMs?: number) {
  return { id, name: id, date_closed: closedMs === undefined ? undefined : String(closedMs) };
}

// Builds a fetchPage function backed by a pre-baked list of 100-task pages.
function pager(pages: any[][]) {
  return async (p: number) => pages[p] ?? [];
}

describe('collectTasksInCloseWindow', () => {
  it('returns nothing when no tasks are closed', async () => {
    const res = await collectTasksInCloseWindow(pager([[task('a'), task('b')]]), 1000, 2000);
    assert.deepEqual(res.tasks, []);
    assert.equal(res.hitCap, false);
    assert.equal(res.pagesScanned, 1);
  });

  it('filters by [from, to] window on date_closed', async () => {
    const inside = task('inside', 1500);
    const before = task('before', 500);
    const after = task('after', 2500);
    const res = await collectTasksInCloseWindow(pager([[before, inside, after]]), 1000, 2000);
    assert.deepEqual(res.tasks.map(t => t.id), ['inside']);
  });

  it('treats from-only as an open upper bound', async () => {
    const res = await collectTasksInCloseWindow(
      pager([[task('a', 500), task('b', 1500), task('c', 5000)]]),
      1000,
      undefined,
    );
    assert.deepEqual(res.tasks.map(t => t.id), ['b', 'c']);
  });

  it('treats to-only as an open lower bound', async () => {
    const res = await collectTasksInCloseWindow(
      pager([[task('a', 500), task('b', 1500), task('c', 5000)]]),
      undefined,
      2000,
    );
    assert.deepEqual(res.tasks.map(t => t.id), ['a', 'b']);
  });

  it('stops paginating when a page returns fewer than 100 tasks', async () => {
    const full = Array.from({ length: 100 }, (_, i) => task(`p1-${i}`, 1500));
    const partial = [task('p2', 1500)];
    const res = await collectTasksInCloseWindow(pager([full, partial]), 1000, 2000);
    assert.equal(res.pagesScanned, 2);
    assert.equal(res.hitCap, false);
    assert.equal(res.tasks.length, 101);
  });

  it('sets hitCap when every page fills to 100 within the cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => task(`x-${i}`, 1500));
    const pages = Array.from({ length: 3 }, () => full);
    const res = await collectTasksInCloseWindow(pager(pages), 1000, 2000, 3);
    assert.equal(res.pagesScanned, 3);
    assert.equal(res.hitCap, true);
  });

  it('skips tasks with missing or non-numeric date_closed', async () => {
    const t1 = task('good', 1500);
    const t2 = { id: 'bad', name: 'bad', date_closed: 'not-a-number' };
    const t3 = task('missing');
    const res = await collectTasksInCloseWindow(pager([[t1, t2, t3]]), 1000, 2000);
    assert.deepEqual(res.tasks.map(t => t.id), ['good']);
  });

  it('handles an empty first page cleanly', async () => {
    const res = await collectTasksInCloseWindow(pager([[]]), 1000, 2000);
    assert.deepEqual(res.tasks, []);
    assert.equal(res.hitCap, false);
    assert.equal(res.pagesScanned, 1);
  });
});
