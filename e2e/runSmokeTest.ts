import { writeForensicsBundle } from './forensics.ts';
import type { ClientName, Driver } from './drivers/driver.ts';
import type { Mode } from './promptTemplates.ts';

export interface AssertionSpec {
  containsBetween?: [string, string];
  includes?: string[];
}

export interface SmokeTestSpec<Ctx = void> {
  name: string;
  client: ClientName;
  mode: Mode;
  setup?: () => Promise<Ctx>;
  teardown?: (ctx: Ctx) => Promise<void>;
  prompt: string | ((ctx: Ctx) => string);
  assertions: AssertionSpec | ((ctx: Ctx) => AssertionSpec);
}

export async function runSmokeTest<Ctx = void>(spec: SmokeTestSpec<Ctx>): Promise<void> {
  let ctx = undefined as unknown as Ctx;
  let setupRan = false;
  let caught: unknown;
  let response: string | undefined;
  const startedAt = Date.now();

  // Setup runs BEFORE driver creation so an Appium session isn't held open
  // while we're talking to Google. If setup fails, the test fails fast and
  // teardown is not attempted (there's nothing to clean up).
  try {
    if (spec.setup) {
      ctx = await spec.setup();
      setupRan = true;
    }
  } catch (err) {
    caught = err;
  }

  let driver: Driver | undefined;
  if (!caught) {
    try {
      driver = await loadDriver(spec.client);
      await driver.newConversation();

      const promptText = typeof spec.prompt === 'function' ? spec.prompt(ctx) : spec.prompt;
      response = await driver.sendAndWait(promptText);

      const assertions =
        typeof spec.assertions === 'function' ? spec.assertions(ctx) : spec.assertions;
      assertResponse(response, assertions);
    } catch (err) {
      caught = err;
    }
  }

  if (driver) {
    await writeForensicsBundle({
      testName: spec.name,
      client: spec.client,
      prompt: resolvePromptForForensics(spec.prompt, ctx),
      response,
      error: caught,
      driver,
      startedAt,
    });
    try {
      await driver.dispose();
    } catch (disposeErr) {
      if (!caught) caught = disposeErr;
    }
  }

  // Teardown runs even if the assertion failed — leaving scratch resources
  // around is the bigger problem.
  if (setupRan && spec.teardown) {
    try {
      await spec.teardown(ctx);
    } catch (teardownErr) {
      // Don't mask the original failure; surface teardown errors only if
      // the test was otherwise green.
      if (!caught) caught = teardownErr;
      else {
        console.error('[e2e] teardown failed (suppressed because test already failed):', teardownErr);
      }
    }
  }

  if (caught) throw caught;
}

function resolvePromptForForensics<Ctx>(
  prompt: SmokeTestSpec<Ctx>['prompt'],
  ctx: Ctx,
): string {
  try {
    return typeof prompt === 'function' ? prompt(ctx) : prompt;
  } catch {
    return '<prompt failed to render — setup error prevented context>';
  }
}

async function loadDriver(client: ClientName): Promise<Driver> {
  if (client === 'claude-desktop') {
    const { createClaudeDesktopDriver } = await import('./drivers/claude-desktop.ts');
    return createClaudeDesktopDriver();
  }
  const { createChatGptWebDriver } = await import('./drivers/chatgpt-web.ts');
  return createChatGptWebDriver();
}

function assertResponse(response: string, assertions: AssertionSpec): void {
  let body = response;
  if (assertions.containsBetween) {
    const [start, end] = assertions.containsBetween;
    const startIdx = body.indexOf(start);
    if (startIdx === -1) {
      throw new Error(
        `Response missing start delimiter ${JSON.stringify(start)}. Response: ${truncate(response)}`,
      );
    }
    const endIdx = body.indexOf(end, startIdx + start.length);
    if (endIdx === -1) {
      throw new Error(
        `Response missing end delimiter ${JSON.stringify(end)}. Response: ${truncate(response)}`,
      );
    }
    body = body.slice(startIdx + start.length, endIdx);
  }
  for (const needle of assertions.includes ?? []) {
    if (!body.includes(needle)) {
      throw new Error(
        `Response missing expected substring ${JSON.stringify(needle)}. Body: ${truncate(body)}`,
      );
    }
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}
