// Source of truth: which Google Calendar MCP tools are read-only vs write/mutating.
//
// Generated from src/google-calendar/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.

export const READ_TOOLS = [
  'listCalendars',
  'listEvents',
  'getEvent',
] as const;

export const WRITE_TOOLS = [
  'createEvent',
  'updateEvent',
  'deleteEvent',
] as const;

export const NOT_IMPLEMENTED = new Set<string>();

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
