// src/__tests__/github/server.test.ts
// The registration layer: every tool is registered with the right annotation,
// and every execute reaches GitHub through withGitHubClient with its own error
// prefix and resource context. Tools are captured by patching
// FastMCP.prototype.addTool before import (the ClickUp suite's technique).
import assert from 'node:assert/strict';
import { describe, it, after, before } from 'node:test';

const toolMap = new Map<string, any>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
await import('../../github/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const READS = [
  'searchRepositories', 'getFileContents', 'listCommits', 'listIssues', 'getIssue', 'searchCode',
  'searchIssues', 'searchUsers', 'listPullRequests', 'getPullRequest', 'getPullRequestFiles',
  'getPullRequestStatus', 'getPullRequestComments', 'getPullRequestReviews',
];
const WRITES = [
  'createRepository', 'forkRepository', 'createOrUpdateFile', 'pushFiles', 'createBranch', 'createIssue',
  'updateIssue', 'addIssueComment', 'createPullRequest', 'createPullRequestReview', 'mergePullRequest',
  'updatePullRequestBranch',
];

/** Minimal valid args per tool, parsed through the tool's own schema. */
const ARGS: Record<string, Record<string, unknown>> = {
  searchRepositories: { query: 'mcp' },
  searchCode: { query: 'x' },
  searchIssues: { query: 'x' },
  searchUsers: { query: 'x' },
  createRepository: { name: 'r' },
  forkRepository: { owner: 'o', repo: 'r' },
  getFileContents: { owner: 'o', repo: 'r', path: 'a.md' },
  createOrUpdateFile: { owner: 'o', repo: 'r', path: 'a.md', content: 'x', message: 'm', branch: 'main', sha: 's' },
  pushFiles: { owner: 'o', repo: 'r', branch: 'main', message: 'm', files: [{ path: 'a', content: 'x' }] },
  createBranch: { owner: 'o', repo: 'r', branch: 'b', fromBranch: 'main' },
  listCommits: { owner: 'o', repo: 'r' },
  listIssues: { owner: 'o', repo: 'r' },
  getIssue: { owner: 'o', repo: 'r', issueNumber: 3 },
  createIssue: { owner: 'o', repo: 'r', title: 't' },
  updateIssue: { owner: 'o', repo: 'r', issueNumber: 3, title: 't' },
  addIssueComment: { owner: 'o', repo: 'r', issueNumber: 3, body: 'b' },
  listPullRequests: { owner: 'o', repo: 'r' },
  getPullRequest: { owner: 'o', repo: 'r', pullNumber: 4 },
  createPullRequest: { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main' },
  createPullRequestReview: { owner: 'o', repo: 'r', pullNumber: 4, event: 'APPROVE' },
  mergePullRequest: { owner: 'o', repo: 'r', pullNumber: 4 },
  getPullRequestFiles: { owner: 'o', repo: 'r', pullNumber: 4 },
  getPullRequestStatus: { owner: 'o', repo: 'r', pullNumber: 4 },
  updatePullRequestBranch: { owner: 'o', repo: 'r', pullNumber: 4 },
  getPullRequestComments: { owner: 'o', repo: 'r', pullNumber: 4 },
  getPullRequestReviews: { owner: 'o', repo: 'r', pullNumber: 4 },
};

const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
const realFetch = globalThis.fetch;

describe('github server registration', () => {
  it('registers the 26 ported tools plus the two shared REST tools', () => {
    for (const name of [...READS, ...WRITES]) assert.ok(toolMap.has(name), `${name} registered`);
    assert.ok(toolMap.has('mintRestBearerForCurl'));
    assert.ok(toolMap.has('listRestEndpoints'));
    assert.equal(READS.length + WRITES.length, 26);
  });

  it('annotates reads read-only and writes as writes, with no destructive hint (nothing here deletes)', () => {
    for (const name of READS) assert.equal(toolMap.get(name).annotations.readOnlyHint, true, name);
    for (const name of WRITES) {
      assert.equal(toolMap.get(name).annotations.readOnlyHint, false, name);
      assert.notEqual(toolMap.get(name).annotations.destructiveHint, true, name);
    }
  });

  it('every parameter carries a description, so the model knows how to fill it', () => {
    for (const name of [...READS, ...WRITES]) {
      for (const [field, schema] of Object.entries<any>(toolMap.get(name).parameters.shape)) {
        assert.ok(schema.description, `${name}.${field} has no .describe()`);
      }
    }
  });

  it('reports a missing connection without calling GitHub', async () => {
    await assert.rejects(toolMap.get('listIssues').execute(ARGS.listIssues, { log, session: {} }), /GitHub not connected/);
  });

  describe('each execute reaches GitHub with its own prefix and resource', () => {
    before(() => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    });
    after(() => { globalThis.fetch = realFetch; });

    for (const name of [...READS, ...WRITES]) {
      it(name, async () => {
        const tool = toolMap.get(name);
        const args = tool.parameters.parse(ARGS[name]);
        const session = { githubAccessToken: 'ghp_server_test_token' };
        await assert.rejects(tool.execute(args, { log, session }), (err: any) => {
          // Either the wrapper's prefixed mapping, or an op that already turned
          // the 404 into its own sentence (a missing branch).
          assert.match(err.message, /^Failed to |does not exist/, `${name}: ${err.message}`);
          return true;
        });
      });
    }

    it('names the resource in a 404, not just "resource"', async () => {
      const tool = toolMap.get('getIssue');
      await assert.rejects(
        tool.execute(tool.parameters.parse(ARGS.getIssue), { log, session: { githubAccessToken: 't' } }),
        /issue #3 in o\/r was not found/,
      );
    });
  });
});
