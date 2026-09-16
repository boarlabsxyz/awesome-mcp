import { writeForensicsBundle } from './forensics.ts';
import { findReportedFailure } from './assertions.ts';
import type { ClientName, Driver } from './drivers/driver.ts';

export interface SmokeTestSpec {
  name: string;
  client: ClientName;
  prompt: string;
  assertions: {
    containsBetween?: [string, string];
    includes?: string[];
    /** Literal substrings that must NOT appear. Case-sensitive. */
    excludes?: string[];
    /**
     * The body must match. Use when the answer cannot be known in advance --
     * "some title came back" is still an assertion, and containsBetween alone
     * passes on an empty envelope.
     */
    matchesBody?: RegExp;
    /**
     * Fail if the reply reads as the model reporting a failure.
     *
     * Checked against the WHOLE reply, not the slice between delimiters: a model
     * that cannot complete the task often produces a well-formed envelope and
     * explains itself around it.
     */
    mustNotReportFailure?: boolean;
    /** Extra phrases to treat as a reported failure, for this test only. */
    failurePhrases?: string[];
  };
}

export async function runSmokeTest(spec: SmokeTestSpec): Promise<void> {
  const driver = await loadDriver(spec.client);
  const startedAt = Date.now();
  let response: string | undefined;
  let caught: unknown;

  try {
    await driver.newConversation();
    response = await driver.sendAndWait(spec.prompt);
    assertResponse(response, spec.assertions);
  } catch (err) {
    caught = err;
  }

  await writeForensicsBundle({
    testName: spec.name,
    client: spec.client,
    prompt: spec.prompt,
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

  if (caught) throw caught;
}

async function loadDriver(client: ClientName): Promise<Driver> {
  if (client === 'claude-desktop') {
    const { createClaudeDesktopDriver } = await import('./drivers/claude-desktop.ts');
    return createClaudeDesktopDriver();
  }
  if (client === 'claude-web') {
    const { createClaudeWebDriver } = await import('./drivers/claude-web.ts');
    return createClaudeWebDriver();
  }
  const { createChatGptWebDriver } = await import('./drivers/chatgpt-web.ts');
  return createChatGptWebDriver();
}

function assertResponse(response: string, assertions: SmokeTestSpec['assertions']): void {
  if (assertions.mustNotReportFailure) {
    const phrase = findReportedFailure(response, assertions.failurePhrases);
    if (phrase !== null) {
      throw new Error(
        `The model reported a failure (matched ${JSON.stringify(phrase)}). The task may have ` +
          'been impossible, or a tool refused it and the model explained rather than failed. ' +
          `Read the tool calls in the forensics bundle. Response: ${truncate(response)}`,
      );
    }
  }

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
  if (assertions.matchesBody && !assertions.matchesBody.test(body)) {
    throw new Error(
      `Body does not match ${assertions.matchesBody}. Body: ${truncate(body)}`,
    );
  }
  for (const banned of assertions.excludes ?? []) {
    if (body.includes(banned)) {
      throw new Error(
        `Response contains banned substring ${JSON.stringify(banned)}. Body: ${truncate(body)}`,
      );
    }
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}
