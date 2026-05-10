import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Test the instance name migration logic used in /api/me endpoint.
// This is the same logic used in webServer.ts for auto-migrating old names.

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
  const email = googleEmail || providerEmail;
  const prefix = email ? email.split('@')[0] : '';
  const newName = prefix ? `${prefix} ${serviceName}` : serviceName;
  return { newName, changed: newName !== instanceName };
}

describe('Instance name migration logic', () => {
  it('should strip " MCP" and prepend email prefix for Google services', () => {
    const result = migrateInstanceName('Google Docs MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'evgen Google Docs');
    assert.equal(result.changed, true);
  });

  it('should strip " MCP" and prepend email prefix for Gmail', () => {
    const result = migrateInstanceName('Gmail MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'evgen Gmail');
    assert.equal(result.changed, true);
  });

  it('should strip " MCP" for Slack (no email available)', () => {
    const result = migrateInstanceName('Slack MCP', null, null);
    assert.equal(result.newName, 'Slack');
    assert.equal(result.changed, true);
  });

  it('should strip " MCP" and use providerEmail for ClickUp', () => {
    const result = migrateInstanceName('ClickUp MCP', null, 'evgen@boarlabs.xyz');
    assert.equal(result.newName, 'evgen ClickUp');
    assert.equal(result.changed, true);
  });

  it('should prefer googleEmail over providerEmail', () => {
    const result = migrateInstanceName('Google Docs MCP', 'google@test.com', 'provider@test.com');
    assert.equal(result.newName, 'google Google Docs');
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
    assert.equal(result.newName, 'nick Google Sheets');
    assert.equal(result.changed, true);
  });

  it('should handle Google Calendar MCP', () => {
    const result = migrateInstanceName('Google Calendar MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user Google Calendar');
    assert.equal(result.changed, true);
  });

  it('should handle Google Slides MCP', () => {
    const result = migrateInstanceName('Google Slides MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user Google Slides');
    assert.equal(result.changed, true);
  });

  it('should handle Google Drive MCP', () => {
    const result = migrateInstanceName('Google Drive MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user Google Drive');
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

  // ClickUp: workspace names first, then email prefix
  if (opts.provider === 'clickup') {
    if (opts.workspaceNames && opts.workspaceNames.length > 0) {
      return `${opts.workspaceNames.join(', ')} ${serviceName}`;
    }
    const prefix = opts.providerEmail ? opts.providerEmail.split('@')[0] : null;
    return prefix ? `${prefix} ${serviceName}` : serviceName;
  }

  // Slack: team name
  if (opts.provider === 'slack' || opts.provider === 'slack-bot') {
    return `${opts.teamName || 'workspace'} ${serviceName}`;
  }

  // Google: email prefix
  const prefix = opts.googleEmail ? opts.googleEmail.split('@')[0] : null;
  return prefix ? `${prefix} ${serviceName}` : serviceName;
}

describe('Instance name generation logic', () => {
  describe('Google services', () => {
    it('should generate name from email prefix + service', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: 'evgen@boarlabs.xyz' });
      assert.equal(name, 'evgen Google Docs');
    });

    it('should fall back to service name only when no email', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: null });
      assert.equal(name, 'Google Docs');
    });

    it('should handle Gmail', () => {
      const name = generateInstanceName('Gmail MCP', { googleEmail: 'nick@speed.com' });
      assert.equal(name, 'nick Gmail');
    });
  });

  describe('ClickUp', () => {
    it('should use workspace names when available', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['Boarlabs'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'Boarlabs ClickUp');
    });

    it('should join multiple workspace names', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['Boarlabs', 'Acme Corp'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'Boarlabs, Acme Corp ClickUp');
    });

    it('should fall back to email prefix when no workspaces', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: [],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'evgen ClickUp');
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
    it('should use team name for Slack user OAuth', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: 'Speed & Function',
      });
      assert.equal(name, 'Speed & Function Slack');
    });

    it('should use team name for Slack bot', () => {
      const name = generateInstanceName('Slack Bot MCP', {
        provider: 'slack-bot',
        teamName: 'Acme',
      });
      assert.equal(name, 'Acme Slack Bot');
    });

    it('should fall back to "workspace" when no team name', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: null,
      });
      assert.equal(name, 'workspace Slack');
    });
  });
});
