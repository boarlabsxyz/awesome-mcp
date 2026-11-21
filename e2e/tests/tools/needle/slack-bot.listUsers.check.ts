import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// listUsers has no zero shape: users.list on a valid token always includes at
// least the person who installed the app, so its `No users found.` is reachable
// only on a page that happens to be all bots and deleted accounts -- not a state
// an account can be seeded into.
//
// The needle is a user ID rather than a name: names are editable by the user,
// the ID is not. The handler drops bots and deleted users (src/slack/server.ts,
// listUsers), so the fixture user must be an active human.

const env = serviceEnv('slack-bot', ['E2E_FIXTURE_SLACKBOT_USER_ID']);

test('slack-bot listUsers lists the fixture user', { timeout: 30_000, skip: env.skip }, async () => {
  const USER_ID = env.get('E2E_FIXTURE_SLACKBOT_USER_ID');

  await runToolCheck({
    tool: 'listUsers',
    service: 'slack-bot',
    account: 'fixture',
    shape: 'needle',
    args: {},
    invariants: {
      excludes: ['No users found.'],
      transportSafe: true,
      // `${displayName} (@${name}) — ID: ${id}`, one per line.
      predicate: (body) => {
        if (body.includes(`) — ID: ${USER_ID}`)) return undefined;
        return body.includes('More users available')
          ? `${USER_ID} is not on the first page (users.list pages at 200). Point ` +
              'E2E_FIXTURE_SLACKBOT_USER_ID at a user on the first page, or the fixture at a smaller workspace.'
          : `${USER_ID} is not listed. It must be an active, non-bot member of the fixture workspace.`;
      },
    },
  });
});
