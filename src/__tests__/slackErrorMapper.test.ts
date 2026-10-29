import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapSlackErrorToHttpStatus, slackWriteErrorStatus } from '../website/slackErrorMapper.js';

describe('mapSlackErrorToHttpStatus', () => {
  describe('embedded HTTP status from "HTTP error (NNN)" transport messages', () => {
    it('mirrors a 401', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API HTTP error (401): nope' }),
        401,
      );
    });

    it('mirrors a 403', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API HTTP error (403): forbidden' }),
        403,
      );
    });

    it('mirrors a 404', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API HTTP error (404): not found' }),
        404,
      );
    });

    it('mirrors a 429', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API HTTP error (429): rate' }),
        429,
      );
    });

    it('falls through for unsupported HTTP codes (e.g. 502)', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API HTTP error (502): upstream' }),
        500,
      );
    });
  });

  describe('Slack-level error codes', () => {
    it('returns 429 for "rate limit" prose', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack rate limit exceeded. Try again in a moment.' }),
        429,
      );
    });

    it('returns 429 for "ratelimited" slack code', () => {
      assert.equal(
        mapSlackErrorToHttpStatus({ message: 'Slack API error (foo): ratelimited' }),
        429,
      );
    });

    for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired']) {
      it(`returns 401 for ${code}`, () => {
        assert.equal(
          mapSlackErrorToHttpStatus({ message: `Slack API error (foo): ${code}` }),
          401,
        );
      });
    }

    for (const code of ['missing_scope', 'account_inactive', 'no_permission']) {
      it(`returns 403 for ${code}`, () => {
        assert.equal(
          mapSlackErrorToHttpStatus({ message: `Slack API error (foo): ${code}` }),
          403,
        );
      });
    }

    for (const code of ['channel_not_found', 'user_not_found', 'thread_not_found', 'not_in_channel']) {
      it(`returns 404 for ${code}`, () => {
        assert.equal(
          mapSlackErrorToHttpStatus({ message: `Slack API error (foo): ${code}` }),
          404,
        );
      });
    }
  });

  describe('fallback', () => {
    it('returns 500 for an unknown message', () => {
      assert.equal(mapSlackErrorToHttpStatus({ message: 'something went wrong' }), 500);
    });

    it('returns 500 for an err with no message', () => {
      assert.equal(mapSlackErrorToHttpStatus({}), 500);
    });

    it('returns 500 for null/undefined err', () => {
      assert.equal(mapSlackErrorToHttpStatus(null), 500);
      assert.equal(mapSlackErrorToHttpStatus(undefined), 500);
    });
  });
});

describe('slackWriteErrorStatus', () => {
  it('prefers the status a write op tagged its refusal with', () => {
    // The rewritten message has no Slack code left in it, so text matching
    // alone would answer 500.
    assert.equal(slackWriteErrorStatus({ message: 'Slack will not let this connection edit', status: 403 }), 403);
    assert.equal(slackWriteErrorStatus({ message: 'Slack posting is disabled', status: 503 }), 503);
  });

  it('maps write-only Slack codes the read mapper does not know', () => {
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): is_archived' }), 403);
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): restricted_action' }), 403);
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): no_text' }), 400);
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): msg_too_long' }), 400);
  });

  it('never answers 401: a revoked connection token is the upstream refusing, not the caller bearer', () => {
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): invalid_auth' }), 502);
    assert.equal(slackWriteErrorStatus({ message: 'Slack API HTTP error (401): nope' }), 502);
  });

  it('falls back to the read mapping for everything else', () => {
    assert.equal(slackWriteErrorStatus({ message: 'Slack API error (chat.postMessage): channel_not_found' }), 404);
    assert.equal(slackWriteErrorStatus({ message: 'Slack rate limit exceeded.' }), 429);
    assert.equal(slackWriteErrorStatus(new Error('boom')), 500);
  });
});
