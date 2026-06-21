export type ClientName = 'claude-desktop' | 'chatgpt-web';

export interface Driver {
  newConversation(): Promise<void>;
  sendAndWait(prompt: string): Promise<string>;
  captureAccessibilitySnapshot(): Promise<string>;
  captureScreenshot(): Promise<Buffer>;
  appVersion(): Promise<string>;
  dispose(): Promise<void>;
}
