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
  const email = googleEmail || providerEmail;
  const newName = email ? `${email} ${titleCase(serviceName)}` : titleCase(serviceName);
  return { newName, changed: newName !== instanceName };
}

describe('Instance name migration logic', () => {
  it('should use full email as-is for Google services', () => {
    const result = migrateInstanceName('Google Docs MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'evgen@boarlabs.xyz Google Docs');
    assert.equal(result.changed, true);
  });

  it('should use full email as-is for Gmail', () => {
    const result = migrateInstanceName('Gmail MCP', 'evgen@boarlabs.xyz', null);
    assert.equal(result.newName, 'evgen@boarlabs.xyz Gmail');
    assert.equal(result.changed, true);
  });

  it('should strip " MCP" and capitalize for Slack (no email)', () => {
    const result = migrateInstanceName('Slack MCP', null, null);
    assert.equal(result.newName, 'Slack');
    assert.equal(result.changed, true);
  });

  it('should use full providerEmail as-is for ClickUp', () => {
    const result = migrateInstanceName('ClickUp MCP', null, 'evgen@boarlabs.xyz');
    assert.equal(result.newName, 'evgen@boarlabs.xyz ClickUp');
    assert.equal(result.changed, true);
  });

  it('should prefer googleEmail over providerEmail', () => {
    const result = migrateInstanceName('Google Docs MCP', 'google@test.com', 'provider@test.com');
    assert.equal(result.newName, 'google@test.com Google Docs');
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

  it('should handle Google Sheets MCP with email as-is', () => {
    const result = migrateInstanceName('Google Sheets MCP', 'nick@speedandfunction.com', null);
    assert.equal(result.newName, 'nick@speedandfunction.com Google Sheets');
    assert.equal(result.changed, true);
  });

  it('should handle Google Calendar MCP', () => {
    const result = migrateInstanceName('Google Calendar MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user@example.com Google Calendar');
    assert.equal(result.changed, true);
  });

  it('should handle Google Slides MCP', () => {
    const result = migrateInstanceName('Google Slides MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user@example.com Google Slides');
    assert.equal(result.changed, true);
  });

  it('should handle Google Drive MCP', () => {
    const result = migrateInstanceName('Google Drive MCP', 'user@example.com', null);
    assert.equal(result.newName, 'user@example.com Google Drive');
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

  // ClickUp: workspace names first, then full email
  if (opts.provider === 'clickup') {
    if (opts.workspaceNames && opts.workspaceNames.length > 0) {
      return titleCase(`${opts.workspaceNames.join(', ')} ${serviceName}`);
    }
    return opts.providerEmail ? `${opts.providerEmail} ${titleCase(serviceName)}` : titleCase(serviceName);
  }

  // Slack: team name
  if (opts.provider === 'slack' || opts.provider === 'slack-bot') {
    return titleCase(`${opts.teamName || 'workspace'} ${serviceName}`);
  }

  // Google: full email as-is, capitalize service name only
  return opts.googleEmail ? `${opts.googleEmail} ${titleCase(serviceName)}` : titleCase(serviceName);
}

describe('Instance name generation logic', () => {
  describe('Google services', () => {
    it('should generate name from full email (as-is) + capitalized service', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: 'evgen@boarlabs.xyz' });
      assert.equal(name, 'evgen@boarlabs.xyz Google Docs');
    });

    it('should fall back to service name only when no email', () => {
      const name = generateInstanceName('Google Docs MCP', { googleEmail: null });
      assert.equal(name, 'Google Docs');
    });

    it('should handle Gmail with email as-is', () => {
      const name = generateInstanceName('Gmail MCP', { googleEmail: 'nick@speed.com' });
      assert.equal(name, 'nick@speed.com Gmail');
    });
  });

  describe('ClickUp', () => {
    it('should use workspace names when available, capitalized', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['boarlabs'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'Boarlabs ClickUp');
    });

    it('should join multiple workspace names, capitalized', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: ['boarlabs', 'acme corp'],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'Boarlabs, Acme Corp ClickUp');
    });

    it('should fall back to email as-is when no workspaces', () => {
      const name = generateInstanceName('ClickUp MCP', {
        provider: 'clickup',
        workspaceNames: [],
        providerEmail: 'evgen@boarlabs.xyz',
      });
      assert.equal(name, 'evgen@boarlabs.xyz ClickUp');
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
    it('should use team name for Slack user OAuth, capitalized', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: 'speed & function',
      });
      assert.equal(name, 'Speed & Function Slack');
    });

    it('should use team name for Slack bot, capitalized', () => {
      const name = generateInstanceName('Slack Bot MCP', {
        provider: 'slack-bot',
        teamName: 'acme',
      });
      assert.equal(name, 'Acme Slack Bot');
    });

    it('should fall back to "workspace" when no team name', () => {
      const name = generateInstanceName('Slack MCP', {
        provider: 'slack',
        teamName: null,
      });
      assert.equal(name, 'Workspace Slack');
    });
  });
});
