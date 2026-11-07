import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPrefix } from '../../sandbox/provider.js';

/** A stream of the given chunks that records whether it was cancelled. */
function chunks(...parts: number[][]) {
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled < parts.length) controller.enqueue(new Uint8Array(parts[state.pulled++]));
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

describe('readPrefix', () => {
  it('stops at maxBytes, mid-chunk, and cancels the rest of the download', async () => {
    const { stream, state } = chunks([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    assert.deepEqual([...await readPrefix(stream, 5)], [1, 2, 3, 4, 5]);
    assert.equal(state.pulled, 2, 'the third chunk is never fetched');
    assert.equal(state.cancelled, true);
  });

  it('returns a whole stream shorter than maxBytes', async () => {
    const { stream } = chunks([1, 2], [3]);
    assert.deepEqual([...await readPrefix(stream, 10)], [1, 2, 3]);
  });
});
