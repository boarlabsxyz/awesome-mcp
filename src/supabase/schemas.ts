// src/supabase/schemas.ts
// The shared building blocks of the Supabase tool schemas: enums, the fields
// several tools take, and the definition type. The tools themselves are
// declared in server.ts, one `supabaseTool({...})` call each, so that
// scripts/buildMcpToolsDoc.mjs can read their names and descriptions as
// literals (it parses source text and cannot follow a table built from
// constants).
//
// Every schema is a LOCAL COPY of the contract of Supabase's hosted MCP
// server, mirrored from https://github.com/supabase-community/supabase-mcp
// @4a619c13f6dd054bac4ee7fbd3757dd27509ac63. Re-declared rather than fetched
// from the upstream tools/list because FastMCP registers a fixed tool set per
// server and a model must see a schema before its first call; the cost is that
// an upstream rename breaks a tool until this copy follows, and the upstream
// answer then names the problem, since it validates the arguments again.

import { z } from 'zod';

/** Upstream `AWS_REGION_CODES` (src/regions.ts). */
export const SUPABASE_REGIONS = [
  'us-west-1', 'us-east-1', 'us-east-2', 'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1',
  'ap-south-1', 'ap-southeast-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-2',
  'sa-east-1',
] as const;

/** Upstream `logsServiceSchema` (src/platform/types.ts). */
export const LOG_SERVICES = [
  'api', 'branch-action', 'postgres', 'edge-function', 'edge-function-runtime', 'auth', 'storage', 'realtime',
] as const;

export const projectId = z.string().describe('The project ID (its project ref). list_projects returns it.');

export const logWindowStart = z
  .string()
  .datetime({ offset: true })
  .optional()
  .describe('The start of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to 24 hours before the end of the window. The API caps the requested range at 24 hours.');
export const logWindowEnd = z
  .string()
  .datetime({ offset: true })
  .optional()
  .describe('The end of the log window as an ISO 8601 timestamp, including a UTC "Z" suffix or explicit offset. Defaults to the current time. The API caps the requested range at 24 hours.');

export const confirmCostId = z
  .string()
  .optional()
  .describe('The ID returned by `confirm_cost`. Required through this connector: call `get_cost`, tell the user the cost, call `confirm_cost` once they agree, then pass its confirmation_id here.');

export interface SupabaseToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface SupabaseToolDef {
  /** The upstream tool name — also the name this server registers. */
  name: string;
  /** Upstream feature group (Supabase's `features` URL option names these). */
  group: 'docs' | 'account' | 'database' | 'debugging' | 'development' | 'functions' | 'branching';
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  annotations: SupabaseToolAnnotations;
}

export const READ: SupabaseToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
