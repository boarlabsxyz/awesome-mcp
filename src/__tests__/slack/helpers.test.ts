import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { formatTimestamp, buildPermalink, formatMessage, formatBytes, formatFileRef, formatFiles, assertWritesEnabled } from '../../slack/helpers.js';
import { UserError } from 'fastmcp';

describe('Slack helpers', () => {
  describe('formatTimestamp', () => {
    it('should format a Slack timestamp to ISO-like string', () => {
      const result = formatTimestamp('1777282941.123456');
      assert.ok(result.includes('UTC'));
      assert.ok(result.includes('2026'));
    });

    it('should handle integer timestamps', () => {
      const result = formatTimestamp('1609459200.000000');
      assert.ok(result.includes('2021'));
      assert.ok(result.includes('UTC'));
    });
  });

  describe('buildPermalink', () => {
    it('should build a correct Slack permalink', () => {
      const url = buildPermalink('https://boarlabs.slack.com', 'C123ABC', '1777282941.123456');
      assert.equal(url, 'https://boarlabs.slack.com/archives/C123ABC/p1777282941123456');
    });

    it('should strip trailing slash from workspace URL', () => {
      const url = buildPermalink('https://boarlabs.slack.com/', 'C123', '1234.5678');
      assert.equal(url, 'https://boarlabs.slack.com/archives/C123/p12345678');
    });
  });

  describe('formatMessage', () => {
    it('should format a basic message', () => {
      const userNames = new Map([['U123', 'Alice']]);
      const result = formatMessage({ user: 'U123', ts: '1609459200.000000', text: 'Hello' }, userNames);
      assert.ok(result.includes('Alice'));
      assert.ok(result.includes('Hello'));
      assert.ok(result.includes('ts: 1609459200.000000'));
    });

    it('should show reply count', () => {
      const userNames = new Map<string, string>();
      const result = formatMessage({ user: 'U1', ts: '1234.0', text: 'Hi', reply_count: 5 }, userNames);
      assert.ok(result.includes('[5 replies]'));
    });

    it('should include permalink when workspaceUrl and channelId provided', () => {
      const userNames = new Map<string, string>();
      const result = formatMessage(
        { user: 'U1', ts: '1234.5678', text: 'Hi' },
        userNames, 'C123', 'https://workspace.slack.com'
      );
      assert.ok(result.includes('/archives/C123/p12345678'));
    });

    it('should not include permalink when workspaceUrl is empty', () => {
      const userNames = new Map<string, string>();
      const result = formatMessage({ user: 'U1', ts: '1234.5678', text: 'Hi' }, userNames, 'C123', '');
      assert.ok(!result.includes('/archives/'));
    });

    it('should fall back to user ID when not in userNames', () => {
      const userNames = new Map<string, string>();
      const result = formatMessage({ user: 'U999', ts: '1234.0', text: 'Hi' }, userNames);
      assert.ok(result.includes('U999'));
    });

    it('should show unknown when no user', () => {
      const userNames = new Map<string, string>();
      const result = formatMessage({ ts: '1234.0', text: 'Bot msg' }, userNames);
      assert.ok(result.includes('unknown'));
    });
  });

  describe('formatBytes', () => {
    it('should scale units', () => {
      assert.equal(formatBytes(512), '512 B');
      assert.equal(formatBytes(2048), '2 KB');
      assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    });

    it('should handle nonsense sizes', () => {
      assert.equal(formatBytes(NaN), 'unknown size');
      assert.equal(formatBytes(-1), 'unknown size');
    });
  });

  describe('formatFileRef', () => {
    it('should render a normal file with its ID', () => {
      const line = formatFileRef({ id: 'F123', name: 'shot.png', mimetype: 'image/png', size: 493568 });
      assert.ok(line.includes('shot.png'));
      assert.ok(line.includes('image/png'));
      assert.ok(line.includes('482 KB'));
      assert.ok(line.includes('file ID: F123'));
    });

    it('should render a deleted file as a tombstone', () => {
      const line = formatFileRef({ id: 'F123', mode: 'tombstone', name: 'gone.png' });
      assert.ok(line.includes('deleted file'));
      assert.ok(!line.includes('gone.png'));
    });

    it('should tell the user which scope is missing when a file is withheld', () => {
      const line = formatFileRef({ id: 'F123', file_access: 'check_file_info' });
      assert.ok(line.includes('files:read'));
      assert.ok(line.includes('F123'));
    });

    it('should mark external files as not downloadable', () => {
      const line = formatFileRef({
        id: 'F123', name: 'Design doc', mode: 'external', url_private: 'https://drive.google.com/x',
      });
      assert.ok(line.includes('external link'));
      assert.ok(line.includes('not downloadable'));
      assert.ok(line.includes('https://drive.google.com/x'));
    });

    it('should fall back when name/mimetype/size are absent', () => {
      const line = formatFileRef({ id: 'F123', title: 'Untitled thing', filetype: 'pdf' });
      assert.ok(line.includes('Untitled thing'));
      assert.ok(line.includes('pdf'));
      assert.ok(!line.includes('undefined'));
      assert.ok(!line.includes('NaN'));
    });

    it('should not print "undefined" when everything is missing', () => {
      const line = formatFileRef({ id: 'F123' });
      assert.ok(line.includes('(unnamed file)'));
      assert.ok(!line.includes('undefined'));
    });
  });

  describe('formatFiles', () => {
    it('should truncate bulk uploads', () => {
      const files = Array.from({ length: 14 }, (_, i) => ({ id: `F${i}`, name: `f${i}.png` }));
      const lines = formatFiles(files);
      assert.equal(lines.length, 11); // 10 files + the "and N more" line
      assert.ok(lines[10].includes('4 more'));
    });

    it('should not add a truncation line at exactly the cap', () => {
      const files = Array.from({ length: 10 }, (_, i) => ({ id: `F${i}`, name: `f${i}.png` }));
      assert.equal(formatFiles(files).length, 10);
    });
  });

  describe('formatMessage with attachments', () => {
    it('should append file lines', () => {
      const result = formatMessage(
        {
          user: 'U1', ts: '1609459200.000000', text: 'here you go',
          files: [{ id: 'F9', name: 'shot.png', mimetype: 'image/png', size: 1024 }],
        },
        new Map([['U1', 'Alice']]),
      );
      assert.ok(result.includes('here you go'));
      assert.ok(result.includes('shot.png'));
      assert.ok(result.includes('file ID: F9'));
    });

    it('should surface a file-only upload that has no text', () => {
      const result = formatMessage(
        { user: 'U1', ts: '1609459200.000000', text: '', files: [{ id: 'F9', name: 'shot.png' }] },
        new Map(),
      );
      assert.ok(result.includes('shot.png'), 'attachment must be visible even with empty text');
    });

    it('should be unchanged when there are no files', () => {
      const withEmpty = formatMessage({ user: 'U1', ts: '1234.0', text: 'Hi', files: [] }, new Map());
      const without = formatMessage({ user: 'U1', ts: '1234.0', text: 'Hi' }, new Map());
      assert.equal(withEmpty, without);
      assert.ok(!withEmpty.includes('\n'));
    });
  });

  describe('assertWritesEnabled', () => {
    const origEnv = process.env.SLACK_WRITES_ENABLED;

    afterEach(() => {
      if (origEnv === undefined) delete process.env.SLACK_WRITES_ENABLED;
      else process.env.SLACK_WRITES_ENABLED = origEnv;
    });

    it('should throw UserError when SLACK_WRITES_ENABLED is not set', () => {
      delete process.env.SLACK_WRITES_ENABLED;
      assert.throws(() => assertWritesEnabled(), (err: any) => err instanceof UserError);
    });

    it('should throw UserError when SLACK_WRITES_ENABLED is false', () => {
      process.env.SLACK_WRITES_ENABLED = 'false';
      assert.throws(() => assertWritesEnabled(), (err: any) => err instanceof UserError);
    });

    it('should not throw when SLACK_WRITES_ENABLED is true', () => {
      process.env.SLACK_WRITES_ENABLED = 'true';
      assert.doesNotThrow(() => assertWritesEnabled());
    });
  });
});
