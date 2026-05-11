import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Test the instance name migration logic used in /api/me endpoint.
// This is the same logic used in webServer.ts for auto-migrating old names.

function titleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

/** Replicate the migration logic from webServer.ts /api/me handler */
function migrateInstanceName(
  instanceName: string,
  googleEmail: string | null,
  providerEmail: string | null
): { newName: string; changed: boolean } {
  if (!instanceName.includes(' MCP')) {
    return { newName: instanceName, changed: false };
  }
  const serviceName = instanceName.replace(' MCP', '').trim();
  const identifier = googleEmail || providerEmail;
  const newName = identifier ? `${serviceName} (${identifier})` : serviceName;
  return { newName, changed: newName !== instanceName };
}

describe('Instance name migration logic', () => {
  it('should format as "Service (email)" for Google services', () => {
    const result = migrateInstanceName('Google Docs MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'Google Docs (evgen@boarlabs.xyz)');
    assert.equal(result.changed, true);
  });

  it('should format as "Gmail (email)"', () => {
    const result = migrateInstanceName('Gmail MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'Gmail (evgen@boarlabs.xyz)');
    assert.equal(result.changed, true);
  });

  it('should strip " MCP" for Slack (no email)', () => {
    const result = migrateInstanceName('Slack MCP', null, null);
    assert.equal(result.newName, 'Slack');
    assert.equal(result.changed, true);
  });

  it('should format as "ClickUp (email)" for ClickUp', () => {
    const result = migrateInstanceName('ClickUp MCP', null, 'evgen@boarlabs.xyz');
    assert.equal(result.newName, 'ClickUp (evgen@boarlabs.xyz)');
    assert.equal(result.changed, true);
  });

  it('should prefer googleEmail over providerEmail', () => {
    const result = migrateInstanceName('Google Docs MCP', 'google@test.com', 'provider@test.com');
    assert.equal(result.newName, 'Google Docs (google@test.com)');
  });

  it('should not change names that do not contain " MCP"', () => {
    const result = migrateInstanceName('evgen Google Docs', 'evgen@test.com', null);
    assert.equal(result.newName, 'evgen Google Docs');
    assert.equal(result.changed, false);
  });

  it('should not change already-migrated names', () => {
    const result = migrateInstanceName('evgen ClickUp', null, 'evgen@test.com');
    assert.equal(result.newName, 'evgen ClickUp');
    assert.equal(result.changed, false);
  });

  it('should handle names with only " MCP" (edge case)', () => {
    const result = migrateInstanceName(' MCP', null, null);
    assert.equal(result.newName, '');
    assert.equal(result.changed, true);
  });

  it('should handle Google Sheets MCP', () => {
    const result = migrateInstanceName('Google Sheets MCP', 'nick@speedandfunction.com', null);
    assert.equal(result.newName, 'Google Sheets (nick@speedandfunction.com)');
    assert.equal(result.changed, true);
  });

  it('should handle Google Calendar MCP', () => {
    const result = migrateInstanceName('Google Calendar MCP', 'user@example.com', null);
    assert.equal(result.newName, 'Google Calendar (user@example.com)');
    assert.equal(result.changed, true);
  });

  it('should handle Google Slides MCP', () => {
    const result = migrateInstanceName('Google Slides MCP', 'user@example.com', null);
    assert.equal(result.newName, 'Google Slides (user@example.com)');
    assert.equal(result.changed, true);
  });

  it('should handle Google Drive MCP', () => {
    const result = migrateInstanceName('Google Drive MCP', 'user@example.com', null);
    assert.equal(result.newName, 'Google Drive (user@example.com)');
    assert.equal(result.changed, true);
  });
});

/** Replicate the auto-name generation logic from webServer.ts OAuth callbacks */
function generateInstanceName(
  mcpDisplayName: string,
  opts: {
    googleEmail?: string | null;
    providerEmail?: string | null;
    teamName?: string | null;
    workspaceNames?: string[];
    provider?: string;
  }
): string {
  const serviceName = mcpDisplayName.replace(' MCP', '').trim();

  // ClickUp: Service Name (workspace or email)
  if (opts.provider === 'clickup') {
    if (opts.workspaceNames && opts.workspaceNames.length > 0) {
      return `${serviceName} (${opts.workspaceNames.join(', ')})`;
    }
    return opts.providerEmail ? `${serviceName} (${opts.providerEmail})` : serviceName;
  }

  // Slack: Service Name (team name)
  if (opts.provider === 'slack' || opts.provider === 'slack-bot') {
    return `${serviceName} (${opts.teamName || 'workspace'})`;
  }

  // Google: Service Name (email)
  return opts.googleEmail ? `${serviceName} (${opts.googleEmail})` : serviceName;
}

describe('Instance name generation logic', () => {
  describe('Google services', () => {
    it('should generate "Service (email)" format', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: 'evgen@boarlabs.xyz' });
      assert.equal(name, 'Google Docs (evgen@boarlabs.xyz)');
    });

    it('should fall back to service name only when no email', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: null });
      assert.equal(name, 'Google Docs');
    });

    it('should handle Gmail', () => {
      const name = generateInstanceName('Gmail MCP', { googleEmail: 'nick@speed.com' });
      assert.equal(name, 'Gmail (nick@speed.com)');
    });
  });

  describe('ClickUp', () => {
    it('should use workspace name in parens', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['Speed and Function'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'ClickUp (Speed and Function)');
    });

    it('should join multiple workspace names in parens', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['Boarlabs', 'Acme Corp'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'ClickUp (Boarlabs, Acme Corp)');
    });

    it('should fall back to email in parens when no workspaces', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: [],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'ClickUp (evgen@boarlabs.xyz)');
    });

    it('should fall back to service name when no workspaces and no email', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: [],
        providerEmail: null,
      });
      assert.equal(name, 'ClickUp');
    });
  });

  describe('Slack', () => {
    it('should use team name in parens for Slack user OAuth', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: 'Speed & Function',
      });
      assert.equal(name, 'Slack (Speed & Function)');
    });

    it('should use team name in parens for Slack bot', () => {
      const name = generateInstanceName('Slack Bot MCP', {
        provider: 'slack-bot',
        teamName: 'Acme',
      });
      assert.equal(name, 'Slack Bot (Acme)');
    });

    it('should fall back to "workspace" when no team name', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: null,
      });
      assert.equal(name, 'Slack (workspace)');
    });
  });
});
