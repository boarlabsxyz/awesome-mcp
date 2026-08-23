// Source of truth: which Slack (user OAuth) MCP tools are read-only vs write/mutating.
//
// Generated from src/slack-user/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.
//
// NOTE: src/slack-user/ is the user-OAuth server; its catalog slug is `slack`.
// Same tool surface as src/slack/ (bot token) but a different identity and
// per-channel access rules, so it gets its own connector pair and env vars.

export const READ_TOOLS = [
  'listChannels',
  'readChannelHistory',
  'readThreadReplies',
  'listUsers',
] as const;

export const WRITE_TOOLS = [
  'postMessage',
  'replyInThread',
  'openDm',
] as const;

export const NOT_IMPLEMENTED = new Set<string>();

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
