import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapSlackErrorToHttpStatus } from '../website/slackErrorMapper.js';

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
