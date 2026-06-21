import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Driver } from './drivers/driver.ts';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? '.artifacts';

export interface ForensicsInput {
  testName: string;
  client: string;
  prompt: string;
  response?: string;
  error?: unknown;
  driver: Driver;
  startedAt: number;
}

export async function writeForensicsBundle(input: ForensicsInput): Promise<void> {
  const bundleDir = join(
    ARTIFACTS_DIR,
    process.env.GITHUB_SHA ?? 'local',
    input.client,
    input.testName,
  );
  await mkdir(bundleDir, { recursive: true });

  const summary = {
    testName: input.testName,
    client: input.client,
    passed: !input.error,
    error: serializeError(input.error),
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - input.startedAt,
    appVersion: await safe(() => input.driver.appVersion()),
    githubRunId: process.env.GITHUB_RUN_ID,
    githubSha: process.env.GITHUB_SHA,
  };

  await writeFile(join(bundleDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(bundleDir, 'prompt.txt'), input.prompt);
  if (input.response !== undefined) {
    await writeFile(join(bundleDir, 'response.txt'), input.response);
  }

  await tryWrite(bundleDir, 'snapshot.txt', () => input.driver.captureAccessibilitySnapshot());
  await tryWriteBuffer(bundleDir, 'screenshot.png', () => input.driver.captureScreenshot());
}

function serializeError(err: unknown): string | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

async function safe<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function tryWrite(dir: string, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    await writeFile(join(dir, name), await fn());
  } catch (e) {
    await writeFile(join(dir, `${name}.error.txt`), String(e));
  }
}

async function tryWriteBuffer(dir: string, name: string, fn: () => Promise<Buffer>): Promise<void> {
  try {
    await writeFile(join(dir, name), await fn());
  } catch (e) {
    await writeFile(join(dir, `${name}.error.txt`), String(e));
  }
}
