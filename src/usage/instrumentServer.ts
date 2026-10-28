// Records every tool call a FastMCP server executes into tool_call_events.
//
// FastMCP has no per-call hook, and it keeps tools in a private `#tools`, so
// the only chokepoint is registration: this replaces `addTool`/`addTools` with
// versions that wrap each tool's `execute`. That means it MUST run before the
// first tool is added — every server applies it at construction
// (`instrumentServer(new FastMCP(...), slug)`), because tools register at
// import time, including the shared ones from src/sharedTools. A guard test
// (instrumentRegistration.test.ts) fails if a server is constructed without it.
//
// Instrumentation can never change a call's outcome: the result is returned
// and the error rethrown untouched, and recording runs in its own try/catch.
import type { FastMCP } from 'fastmcp';
import { summarizeArgs, summarizeError } from './argSummary.js';
import { recordToolCall } from './usageStore.js';

type AnyTool = { name: string; execute: (args: any, context: any) => Promise<any> };

/** The who/where of a call, read defensively from FastMCP's execute context. */
function contextFields(context: any) {
  const session = context?.session;
  const clientVersion = context?.client?.version;
  return {
    userId: typeof session?.userId === 'number' ? session.userId : null,
    instanceId: typeof session?.instanceId === 'string' ? session.instanceId : null,
    sessionId: typeof context?.sessionId === 'string' ? context.sessionId : null,
    clientName: typeof clientVersion?.name === 'string' ? clientVersion.name : null,
    clientVersion: typeof clientVersion?.version === 'string' ? clientVersion.version : null,
  };
}

/** `tool` with an `execute` that records each call, returning the result and rethrowing the error untouched. */
export function wrapTool<T extends AnyTool>(tool: T, slug: string): T {
  const execute = tool.execute;
  const wrapped = async (args: any, context: any) => {
    const started = performance.now();
    let ok = false;
    let error: unknown;
    let threw = false;
    try {
      const result = await execute.call(tool, args, context);
      ok = !(result && typeof result === 'object' && (result as any).isError === true);
      return result;
    } catch (err) {
      threw = true;
      error = err;
      throw err;
    } finally {
      try {
        const err = threw ? summarizeError(error) : null;
        recordToolCall({
          ...contextFields(context),
          mcpSlug: slug,
          tool: tool.name,
          surface: 'mcp',
          durationMs: performance.now() - started,
          ok,
          errorKind: err ? err.kind : ok ? null : 'isError',
          errorMessage: err ? err.message : null,
          ...summarizeArgs(args),
        });
      } catch {
        // Analytics must never surface in a tool result.
      }
    }
  };
  return { ...tool, execute: wrapped };
}

/** Makes every tool later added to `server` record its calls under `slug`. Must wrap the constructor. */
export function instrumentServer<S extends FastMCP<any>>(server: S, slug: string): S {
  const addTool = server.addTool.bind(server);
  const addTools = server.addTools.bind(server);
  (server as any).addTool = (tool: AnyTool) => addTool(wrapTool(tool, slug) as any);
  (server as any).addTools = (tools: AnyTool[]) => addTools(tools.map((t) => wrapTool(t, slug)) as any);
  return server;
}
