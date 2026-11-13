// tests/generateReleaseNotes.test.js
// Runs generate-release-notes.mjs end to end on its fallback path (no OPENROUTER_API_KEY).
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

function run(commitLines, scopeChanges) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  writeFileSync(join(dir, 'commits.txt'), commitLines.join('\n'));
  writeFileSync(join(dir, 'tasks.txt'), '');
  const args = ['.github/scripts/generate-release-notes.mjs', '--tag', 'v9.9.9', '--date', '2026-01-01T00:00:00Z',
    '--commits', join(dir, 'commits.txt'), '--tasks', join(dir, 'tasks.txt'), '--output-dir', join(dir, 'out')];
  if (scopeChanges) {
    writeFileSync(join(dir, 'scopes.json'), JSON.stringify(scopeChanges));
    args.push('--scope-changes', join(dir, 'scopes.json'));
  }
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  execFileSync('node', args, { env, stdio: 'ignore' });
  const read = name => {
    const file = join(dir, 'out', name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  return { slack: read('slack-message.txt'), html: read('updates-block.html') };
}

describe('generate-release-notes', () => {
  describe('reconnect section', () => {
    it('puts an Action needed section first when a connector gained scopes', () => {
      const { slack } = run(['h1|feat(gmail): Gmail filters|'], [{ slug: 'google-gmail', name: 'Gmail MCP', added: ['x'] }]);
      assert.ok(slack.indexOf('*Action needed*') < slack.indexOf("*What's New*"));
      assert.match(slack, /Reconnect Gmail MCP from your dashboard/);
    });

    it('adds nothing when no scopes changed or no file is given', () => {
      assert.doesNotMatch(run(['h1|feat: Gmail filters|'], []).slack, /Action needed/);
      assert.doesNotMatch(run(['h1|feat: Gmail filters|'], null).slack, /Action needed/);
    });
  });

  describe('connector labels', () => {
    it('labels each bullet with the connector from the commit scope', () => {
      const { slack, html } = run(['h1|feat(gmail): reply drafts|', 'h2|fix(clickup): task list paging|']);
      assert.match(slack, /• \*Gmail:\* reply drafts/);
      assert.match(slack, /• \*ClickUp:\* task list paging/);
      assert.match(html, /<li><strong>Gmail:<\/strong> reply drafts<\/li>/);
    });

    it('names every connector of a multi-scope commit, and none for an unknown scope', () => {
      const { slack } = run(['h1|feat(slack,docs): shared thing|', 'h2|feat(rest): new endpoint|']);
      assert.match(slack, /• \*Slack, Google Docs:\* shared thing/);
      assert.match(slack, /• new endpoint/);
    });

    it('keeps the same connector\'s bullets together', () => {
      const { slack } = run(['h1|feat(gmail): one|', 'h2|feat(slack): two|', 'h3|feat(gmail): three|']);
      assert.ok(slack.indexOf('three') < slack.indexOf('two'));
    });
  });
});
