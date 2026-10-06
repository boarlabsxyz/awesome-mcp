// src/browserbase/schemas.ts
// Zod parameter schemas for every Browserbase tool. Kept out of server.ts so
// ops.ts can type its args from them without an import cycle, and so the REST
// routes in webServer.ts can validate against the same definitions the MCP
// tools do — the only thing stopping the two surfaces drifting.

import { z } from 'zod';

/**
 * The `sessionId` every browser tool takes.
 *
 * Optional at the schema level because the hosted server accepts its absence,
 * but the description is emphatic because in THIS deployment omitting it fails:
 * each tool call opens its own transport to Browserbase, so there is no
 * "current" session to fall back on. Browserbase documents this exact client
 * shape and prescribes passing the id every time. Making it required instead
 * would break `start`, which is the call that mints it.
 */
const sessionIdField = z
  .string()
  .optional()
  .describe(
    'The Browserbase session id returned by start. Pass it on EVERY call: each call reaches Browserbase independently, so without it the call fails with "no active session". Only omit it on start.',
  );

export const startSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      'Optional existing Browserbase session id to reattach to instead of creating a new browser. Omit to create one.',
    ),
});

export const endSchema = z.object({
  sessionId: sessionIdField,
});

/**
 * The page-interaction fields, declared as field OBJECTS rather than schemas so
 * the two surfaces can compose them differently without copying them: the MCP
 * tool adds `sessionId` as a parameter, the REST route takes it from the path.
 * Copying instead would let the surfaces drift on what is valid, which is the
 * whole reason these are separated out. Guarded by
 * src/__tests__/restWriteSchemaSharing.test.ts.
 */
export const navigateFields = {
  url: z
    .string()
    .min(1)
    .describe('Absolute URL to open, including the scheme (e.g. https://example.com). Only http and https are allowed.'),
} as const;

export const actFields = {
  action: z
    .string()
    .min(1)
    .describe(
      'What to do on the current page, in plain language — e.g. "click the Sign in button", "type hello@example.com into the email field". One action per call.',
    ),
} as const;

export const observeFields = {
  instruction: z
    .string()
    .min(1)
    .describe('What to look for on the current page, e.g. "find the login form" or "list the pricing plan rows".'),
} as const;

export const extractFields = {
  instruction: z
    .string()
    .optional()
    .describe('What to pull out of the current page, e.g. "the plan names and their monthly prices". Omit to extract the page text.'),
} as const;

export const navigateSchema = z.object({ ...navigateFields, sessionId: sessionIdField });
export const actSchema = z.object({ ...actFields, sessionId: sessionIdField });
export const observeSchema = z.object({ ...observeFields, sessionId: sessionIdField });
export const extractSchema = z.object({ ...extractFields, sessionId: sessionIdField });

/** Lifecycle states Browserbase reports for a session. */
export const SESSION_STATUS_VALUES = ['RUNNING', 'ERROR', 'TIMED_OUT', 'COMPLETED'] as const;

export const listBrowserSessionsSchema = z.object({
  status: z
    .enum(SESSION_STATUS_VALUES)
    .optional()
    .describe('Filter by lifecycle state. Omit to list every session this key can see. Use RUNNING to find sessions that are still billing.'),
});

export const getBrowserSessionSchema = z.object({
  sessionId: z.string().min(1).describe('The Browserbase session id to look up.'),
});

export const forceEndBrowserSessionSchema = z.object({
  sessionId: z.string().min(1).describe('The Browserbase session id to close.'),
});
