import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The frozen fixture event, found by its time window rather than by `query` --
// the window is the part of listEvents that has to be right, and Google's free
// text search would find the event whatever window was sent. One hour either
// side of the fixture's start.
//
// The start is compared as an instant on the fixture's own row: listEvents
// prints Google's dateTime in the calendar's zone, so a string compare against
// the seeded value would fail on any calendar not set to that zone.

const env = serviceEnv('google-calendar', [
  'E2E_FIXTURE_CAL_EVENT_ID',
  'E2E_FIXTURE_CAL_NEEDLE',
  'E2E_FIXTURE_CAL_EVENT_START',
]);

const HOUR = 60 * 60 * 1000;

test('listEvents finds the fixture event in its window', { timeout: 30_000, skip: env.skip }, async () => {
  const EVENT_ID = env.get('E2E_FIXTURE_CAL_EVENT_ID');
  const NEEDLE = env.get('E2E_FIXTURE_CAL_NEEDLE');
  const START = Date.parse(env.get('E2E_FIXTURE_CAL_EVENT_START'));
  if (!Number.isFinite(START)) throw new Error('E2E_FIXTURE_CAL_EVENT_START is not an ISO 8601 date-time');

  await runToolCheck({
    tool: 'listEvents',
    service: 'google-calendar',
    account: 'fixture',
    shape: 'needle',
    args: {
      calendarId: process.env.E2E_FIXTURE_CAL_ID || 'primary',
      timeMin: new Date(START - HOUR).toISOString(),
      timeMax: new Date(START + HOUR).toISOString(),
    },
    invariants: {
      includes: [NEEDLE, `ID: ${EVENT_ID}`],
      matches: [/^Found \d+ event\(s\):/],
      transportSafe: true,
      predicate: (body) => {
        // Row format: "N. **<summary>**\n   ID: <id>\n   Start: <start>" (src/google-calendar/server.ts:124-126).
        const row = body.match(
          new RegExp(`^\\d+\\. \\*\\*(.*)\\*\\*\\n\\s+ID: ${escapeRegExp(EVENT_ID)}\\n\\s+Start: (\\S+)`, 'm'),
        );
        if (!row) return `no row for event ${EVENT_ID}`;
        const [, title, start] = row;
        if (!title.includes(NEEDLE)) return `the needle is not in the fixture row's title: ${JSON.stringify(title)}`;
        if (Date.parse(start) !== START) {
          return `fixture event should start at ${new Date(START).toISOString()}, listEvents says ${start}`;
        }
        return undefined;
      },
    },
  });
});

// A gap, not a regression: listEvents never reads events.list's nextPageToken
// (src/google-calendar/server.ts:104-119) and renders "Found N event(s):" with
// no hint that N is the maxResults cap rather than the total. A caller asking a
// busy calendar for 50 events is told it found 50 -- the silent-truncation shape
// the root CLAUDE.md forbids ("A capped or partial result must say so"). Flip
// this to a real assertion in the commit that fixes the tool.
test('listEvents says when more events exist beyond maxResults', { todo: 'tool drops nextPageToken and does not report a cap' }, () => {});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
