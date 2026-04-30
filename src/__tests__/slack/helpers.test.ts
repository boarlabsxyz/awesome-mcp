import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatTimestamp, buildPermalink, formatMessage } from '../../slack/helpers.js';

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
});
