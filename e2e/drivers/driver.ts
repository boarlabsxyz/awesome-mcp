// claude-desktop drives the signed Electron app via Appium/macOS Accessibility
// (CDP is fused off) and therefore only runs on the Mac Studio. claude-web and
// chatgpt-web are Playwright over CDP and run anywhere, including Browserbase.
export type ClientName = 'claude-desktop' | 'claude-web' | 'chatgpt-web';

export interface Driver {
  newConversation(): Promise<void>;
  sendAndWait(prompt: string): Promise<string>;
  captureAccessibilitySnapshot(): Promise<string>;
  captureScreenshot(): Promise<Buffer>;
  appVersion(): Promise<string>;
  dispose(): Promise<void>;
}
