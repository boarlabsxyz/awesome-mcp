// Runs one tool against one account over the direct MCP transport.
//
// This is the non-LLM sibling of runSmokeTest. The split is deliberate:
//
//   runSmokeTest   drives a real client (Claude Desktop, or a browser one on
//                  Browserbase) and therefore proves the whole chain -- client,
//                  connector, OAuth, tool, render. Expensive: a conversation per
//                  check, and on Browserbase, billable browser-minutes.
//   runToolCheck   speaks MCP over HTTP with an account's dashboard API key. It
//                  cannot tell you whether a client can reach the tool, but it
//                  answers everything about what the tool returns, in about a
//                  second, with no browser.
//
// So the needle tier keeps runSmokeTest for a handful of representative tools per
// service, and the volume and zero tiers -- the per-tool sweep, 227 tools and
// climbing -- run here.

import {
  endpointFor,
  assertWritable,
  explainToolError,
  type AccountName,
  type ServiceName,
} from './accounts.ts';
import { connectMcp, type McpClient } from './transports/mcpHttp.ts';
import { checkInvariants, type Invariants } from './assertions.ts';
import { writeForensicsBundle } from './forensics.ts';

/**
 * What the data looks like, which is independent of whose account it is.
 *
 *   needle  frozen content, exact substring assertions
 *   volume  enough data that caps, paging and truncation become observable
 *   zero    no data at all -- the empty-state answer, which is the half of the
 *           contract nobody tests and which CLAUDE.md keeps calling out (a bare
 *           "No docs found" reading as "that doc does not exist")
 *
 * A write tool's volume case is seeded in the sandbox rather than run against the
 * rich account: volume is a property of the fixture, not a licence to write
 * somewhere read-only.
 */
export type Shape = 'needle' | 'volume' | 'zero';

/** Handed to setup / readback / teardown so they can reach sibling services. */
export interface CheckContext {
  /** The client for the tool under test. */
  mcp: McpClient;
  /**
   * A client for another service on the same account -- setup for a docs write
   * lives on the drive server (createDocument), not the docs one. Cached per
   * service and closed by the runner.
   */
  service(name: ServiceName): Promise<McpClient>;
}

export interface ToolCheckSpec<C extends object = Record<string, never>> {
  tool: string;
  service: ServiceName;
  account: AccountName;
  shape: Shape;
  /** Declares that this check mutates state. Gates credential resolution. */
  writes?: boolean;
  /** Runs before the call. Seed scratch fixtures here. */
  setup?: (c: CheckContext) => Promise<C>;
  args: Record<string, unknown> | ((ctx: C) => Record<string, unknown>);
  /**
   * Assert against a follow-up read instead of the tool's own reply.
   *
   * A write tool's reply is its own claim that it worked; the only thing that
   * makes a write check meaningful is reading the resource back with a different
   * tool. The write's reply is still checked for isError and kept in forensics.
   */
  readback?: (c: CheckContext, ctx: C) => Promise<string>;
  invariants: Invariants | ((ctx: C) => Invariants);
  /** Always runs, including after a failed assertion. */
  teardown?: (c: CheckContext, ctx: C) => Promise<void>;
  /** The tool is expected to answer with isError: true (bad-input checks). */
  expectToolError?: boolean;
}

export async function runToolCheck<C extends object>(spec: ToolCheckSpec<C>): Promise<void> {
  if (spec.writes) assertWritable(spec.account, spec.tool);

  const startedAt = Date.now();
  const clients = new Map<ServiceName, McpClient>();

  async function service(name: ServiceName): Promise<McpClient> {
    const existing = clients.get(name);
    if (existing) return existing;
    const client = await connectMcp(await endpointFor(spec.account, name));
    clients.set(name, client);
    return client;
  }

  const mcp = await service(spec.service);
  const context: CheckContext = { mcp, service };

  let ctx = {} as C;
  let args: Record<string, unknown> | undefined;
  let response: string | undefined;
  let asserted: string | undefined;
  let caught: unknown;

  try {
    if (spec.setup) ctx = await spec.setup(context);
    args = typeof spec.args === 'function' ? spec.args(ctx) : spec.args;

    const result = await mcp.callTool(spec.tool, args);
    response = result.text;

    if (result.isError && !spec.expectToolError) {
      throw new Error(explainToolError(spec.account, spec.tool, truncate(result.text)));
    }
    if (!result.isError && spec.expectToolError) {
      throw new Error(`${spec.tool} was expected to fail but succeeded: ${truncate(result.text)}`);
    }

    asserted = spec.readback ? await spec.readback(context, ctx) : result.text;
    checkInvariants(
      asserted,
      typeof spec.invariants === 'function' ? spec.invariants(ctx) : spec.invariants,
    );
  } catch (err) {
    caught = err;
  }

  // Teardown before forensics so a scratch resource is cleaned up even if the
  // artifact write fails, and never masking the real failure -- a cleanup error
  // stacked on an assertion error hides the thing you actually need to read.
  if (spec.teardown) {
    try {
      await spec.teardown(context, ctx);
    } catch (teardownErr) {
      if (caught) {
        console.error(`[e2e] teardown for ${spec.tool} also failed: ${message(teardownErr)}`);
      } else {
        caught = new Error(`teardown failed (the check itself passed): ${message(teardownErr)}`);
      }
    }
  }

  await writeForensicsBundle({
    testName: `${spec.tool}.${spec.shape}`,
    client: `direct-${spec.account}`,
    prompt: `${spec.tool}(${JSON.stringify(args ?? {}, null, 2)}) via ${mcp.describe()}`,
    response: spec.readback && asserted !== undefined ? `${response}\n\n--- readback ---\n${asserted}` : response,
    error: caught,
    startedAt,
  });

  await Promise.all([...clients.values()].map((c) => c.close()));
  if (caught) throw caught;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}
