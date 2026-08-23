// Source of truth: which Slack (bot token) MCP tools are read-only vs write/mutating.
//
// Generated from src/slack/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.
//
// NOTE: src/slack/ is the BOT-token server; its catalog slug is `slack-bot`.
// The OAuth user-token server lives in src/slack-user/ under the slug `slack`.
// This file keys off the source directory, not the slug.

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
