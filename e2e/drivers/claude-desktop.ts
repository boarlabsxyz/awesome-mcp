// Drives the signed, production Claude Desktop app via Appium + appium-mac2-driver.
//
// CDP is blocked by Electron Fuses on the signed build, so we use macOS
// Accessibility (XCUITest / AXUIElement) through Appium's mac2 driver instead.
//
// Selectors marked SELECTOR-TODO must be validated against a live AX tree
// dump on the Mac Studio before the suite is trusted. Use:
//   await browser.getPageSource()
// in a REPL session to inspect.

import { remote, type Browser } from 'webdriverio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Driver } from './driver.ts';

const exec = promisify(execFile);

const APPIUM_HOST = process.env.APPIUM_HOST ?? '127.0.0.1';
const APPIUM_PORT = Number(process.env.APPIUM_PORT ?? 4723);
const CLAUDE_APP_BUNDLE = process.env.CLAUDE_APP_BUNDLE ?? 'com.anthropic.claudefordesktop';
const CLAUDE_APP_PATH = process.env.CLAUDE_APP_PATH ?? '/Applications/Claude.app';
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS ?? 120_000);
const POLL_INTERVAL_MS = 500;

export async function createClaudeDesktopDriver(): Promise<Driver> {
  const browser = await remote({
    hostname: APPIUM_HOST,
    port: APPIUM_PORT,
    logLevel: 'warn',
    capabilities: {
      platformName: 'mac',
      'appium:automationName': 'mac2',
      'appium:bundleId': CLAUDE_APP_BUNDLE,
    },
  });

  return {
    async newConversation() {
      // Cmd+N opens a new chat. Conversation isolation between tests prevents
      // history bleed (the harness assumes a clean conversation per test).
      await browser.keys(['Meta', 'n']);
      await browser.pause(750);
    },

    async sendAndWait(prompt) {
      const input = await findChatInput(browser);
      await input.click();
      await input.setValue(prompt);
      // SELECTOR-TODO: confirm the send button or just press Return.
      await browser.keys(['Return']);
      await handleFirstCallPermissionPrompt(browser);
      return waitForResponseComplete(browser);
    },

    async captureAccessibilitySnapshot() {
      return browser.getPageSource();
    },

    async captureScreenshot() {
      const png = await browser.takeScreenshot();
      return Buffer.from(png, 'base64');
    },

    async appVersion() {
      const { stdout } = await exec('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        `${CLAUDE_APP_PATH}/Contents/Info.plist`,
      ]);
      return stdout.trim();
    },

    async dispose() {
      await browser.deleteSession();
    },
  };
}

async function findChatInput(browser: Browser) {
  // SELECTOR-TODO: Claude Desktop renders the composer inside an Electron
  // BrowserView; AX exposes it as a text area. Validate this XCUITest predicate
  // against the live tree.
  return browser.$(
    '-ios predicate string:elementType == 49 OR (elementType == 41 AND value != nil)',
  );
}

async function handleFirstCallPermissionPrompt(browser: Browser): Promise<void> {
  // The first MCP tool call in a session prompts for user approval. We
  // optimistically look for the "Allow" button for a short window; if absent,
  // assume it's pre-approved at the account level.
  // SELECTOR-TODO: confirm button label and AX element type.
  const allow = await browser.$('//XCUIElementTypeButton[@AXTitle="Allow" or @AXTitle="Allow always"]');
  try {
    await allow.waitForExist({ timeout: 4000 });
    await allow.click();
  } catch {
    // Not shown — already approved or no tool call yet. Either is fine.
  }
}

async function waitForResponseComplete(browser: Browser): Promise<string> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  // Streaming-complete signal: the "Stop generating" button disappears.
  // SELECTOR-TODO: validate the AX label; Anthropic may localize it.
  const stopSelector = '//XCUIElementTypeButton[@AXTitle="Stop generating"]';
  while (Date.now() < deadline) {
    const stopButton = await browser.$(stopSelector);
    if (!(await stopButton.isExisting())) {
      await browser.pause(750);
      return extractLastAssistantMessage(browser);
    }
    await browser.pause(POLL_INTERVAL_MS);
  }
  throw new Error(`Claude Desktop response did not complete within ${RESPONSE_TIMEOUT_MS}ms`);
}

async function extractLastAssistantMessage(browser: Browser): Promise<string> {
  // SELECTOR-TODO: replace with the real assistant-turn selector once the AX
  // tree is dumped. Most reliable approach is usually a wrapper element with a
  // stable role/identifier, then concatenating the inner static-text values.
  const messages = await browser.$$(
    '//XCUIElementTypeStaticText[contains(@AXSubrole,"AssistantMessage")]',
  );
  const count = await messages.length;
  if (count === 0) {
    // Fallback: grab the page source so forensics can still extract content.
    throw new Error('Could not locate assistant message in Claude Desktop AX tree');
  }
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(await messages[i].getText());
  }
  return parts.join('\n');
}
