// One place that knows how long a live-client test may take.
//
// The outer node:test timeout MUST exceed the sum of the driver's inner ones.
// When it does not, the runner kills the test first and every diagnostic the
// driver would have produced is lost -- a real cloud run reported three
// identical "test timed out after 240000ms" lines and nothing else, when the
// driver had a specific message ready for each stage that could have failed.
// The inner timeouts exist precisely to say WHICH stage failed; an outer bound
// below their sum discards that and leaves the least informative possible
// failure.
//
// So it is derived, not chosen. Add a stage here and the outer bound moves with
// it, because there is only one copy of the numbers.

const NAVIGATE_MS = Number(process.env.E2E_NAVIGATE_TIMEOUT_MS ?? 45_000);
const COMPOSER_MS = Number(process.env.E2E_COMPOSER_TIMEOUT_MS ?? 30_000);
const RESPONSE_MS = Number(process.env.RESPONSE_TIMEOUT_MS ?? 120_000);

/**
 * Opening a Browserbase session is a network round-trip before the first
 * navigation, and no driver timeout covers it. Budgeted generously on purpose:
 * being wrong here costs a lost diagnostic, being generous costs nothing on a
 * run that passes.
 */
const SESSION_SETUP_MS = 30_000;

/** Forensics: a screenshot plus an accessibility snapshot of a large SPA. */
const FORENSICS_MS = 20_000;

export const TIMEOUTS = {
  navigate: NAVIGATE_MS,
  composer: COMPOSER_MS,
  response: RESPONSE_MS,
} as const;

/**
 * What one task test may take: every stage the driver can spend time in, plus
 * the setup and teardown around it.
 *
 *   newConversation  navigate + find the composer
 *   sendAndWait      find the composer again + wait for the reply
 */
export function taskTimeoutMs(): number {
  const driver = NAVIGATE_MS + COMPOSER_MS + COMPOSER_MS + RESPONSE_MS;
  return SESSION_SETUP_MS + driver + FORENSICS_MS;
}
