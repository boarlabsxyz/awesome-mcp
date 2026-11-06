import { test } from 'node:test';

// A well-formed but nonexistent task id should say "not found". Today it does
// not: getTask (src/clickup/server.ts:196) lets ClickUpClient.request's generic
// `ClickUp API error (${status}): ${body}` through (src/clickup/apiHelpers.ts:362),
// and ClickUp answers an unknown id with 401 `{"err":"Team not authorized",
// "ECODE":"OAUTH_027"}` -- observed live for taskId `zzz9f3a1c7b`. That reads as
// a revoked token, and src/clickup/CLAUDE.md already notes OAUTH_027 is shared by
// a revoked token, a bad id and a disabled ClickApp.
//
// Flip to a real check (account sandbox, expectToolError: true, gated with
// serviceEnv('clickup')) once getTask names "not found, or not visible to this
// account" for an answered 401/404 on a task read, and asserts that string.
test(
  'getTask says a nonexistent task id was not found',
  { todo: 'getTask surfaces ClickUp 401 OAUTH_027 "Team not authorized" for an unknown id (src/clickup/server.ts:196, apiHelpers.ts:362)' },
  () => {},
);
