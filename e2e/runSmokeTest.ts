import { writeForensicsBundle } from './forensics.ts';
import type { ClientName, Driver } from './drivers/driver.ts';

export interface SmokeTestSpec {
  name: string;
  client: ClientName;
  prompt: string;
  assertions: {
    containsBetween?: [string, string];
    includes?: string[];
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
  const { createChatGptWebDriver } = await import('./drivers/chatgpt-web.ts');
  return createChatGptWebDriver();
}

function assertResponse(response: string, assertions: SmokeTestSpec['assertions']): void {
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
