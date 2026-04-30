// src/slack-user/accessControl.ts
// Rule-based access control engine for Slack user OAuth MCP.
import { UserError } from 'fastmcp';
import { SlackClient } from '../slack/apiHelpers.js';
import type { SlackAccessRules } from '../mcpConnectionStore.js';

// --- Glob matching ---

/** Convert a simple glob pattern to a RegExp. Supports * (any chars) and ? (single char). */
export function matchGlob(pattern: string, name: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i'
  );
  return regex.test(name);
}

// --- Channel metadata cache ---

export interface ChannelMeta {
  id: string;
  name: string;
  is_private: boolean;
  is_shared: boolean;
  is_im: boolean;
  is_mpim: boolean;
  user?: string;              // DM counterpart user ID
  shared_team_ids?: string[]; // Orgs this channel is shared with
}

const channelMetaCache = new Map<string, { meta: ChannelMeta; expiresAt: number }>();
const CHANNEL_META_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Fetch channel metadata with caching. */
export async function fetchChannelMeta(
  client: SlackClient,
  channelId: string,
  tokenKey: string,
): Promise<ChannelMeta> {
  const cacheKey = `${tokenKey}:${channelId}`;
  const cached = channelMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;

  const { channel } = await client.conversationsInfo(channelId);
  const meta: ChannelMeta = {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_shared: channel.is_shared || channel.is_ext_shared || channel.is_org_shared,
    is_im: channel.is_im,
    is_mpim: channel.is_mpim,
    user: channel.user,
    shared_team_ids: channel.shared_team_ids,
  };
  channelMetaCache.set(cacheKey, { meta, expiresAt: Date.now() + CHANNEL_META_TTL_MS });
  return meta;
}

// --- Access enforcement ---

/** Check if a channel name matches any pattern in a list. */
function matchesAnyPattern(patterns: string[], name: string): boolean {
  return patterns.some(p => matchGlob(p, name));
}

/**
 * Assert that access to a channel/DM is allowed under the given rules.
 * Throws UserError if access is denied.
 */
export function assertAccess(rules: SlackAccessRules, meta: ChannelMeta): void {
  if (meta.is_im || meta.is_mpim) {
    // DM/MPIM access check
    // 1. Check org allowlist (if configured)
    // Note: org check for DM counterpart requires additional user info lookup
    // which is handled at the tool level if needed.

    // 2. Check user blacklist
    if (meta.user && rules.blacklistUsers.includes(meta.user)) {
      throw new UserError('Access denied: this user is in your blacklist.');
    }
    // DMs pass through (no channel pattern matching)
    return;
  }

  // Channel access check
  // 1. Public-only check
  if (rules.allowPublicOnly && meta.is_private) {
    throw new UserError('Access denied: only public channels are allowed (allowPublicOnly is enabled).');
  }

  // 2. Shared channel org check
  if (meta.is_shared && rules.allowedOrgs.length > 0 && meta.shared_team_ids) {
    const hasAllowedOrg = meta.shared_team_ids.some(tid => rules.allowedOrgs.includes(tid));
    if (!hasAllowedOrg) {
      throw new UserError('Access denied: this shared channel belongs to an organisation not in your allowed list.');
    }
  }

  // 3. Whitelist check (empty whitelist = nothing allowed)
  if (rules.whitelistChannels.length === 0) {
    throw new UserError('Access denied: no channel whitelist patterns configured. Visit the dashboard to configure access rules.');
  }
  if (!matchesAnyPattern(rules.whitelistChannels, meta.name)) {
    throw new UserError(`Access denied: channel #${meta.name} does not match any whitelist pattern.`);
  }

  // 4. Blacklist check
  if (rules.blacklistChannels.length > 0 && matchesAnyPattern(rules.blacklistChannels, meta.name)) {
    throw new UserError(`Access denied: channel #${meta.name} matches a blacklist pattern.`);
  }
}

/**
 * Filter DMs by org membership. Requires async user lookups.
 * Call after filterChannelList to remove DMs with users from non-allowed orgs.
 */
export async function filterDmsByOrg(
  client: SlackClient,
  rules: SlackAccessRules,
  channels: Array<{ is_im?: boolean; is_mpim?: boolean; user?: string; [key: string]: any }>,
): Promise<typeof channels> {
  if (rules.allowedOrgs.length === 0) return channels; // no org restriction

  const dmChannels = channels.filter(ch => !!(ch.is_im) && ch.user);
  if (dmChannels.length === 0) return channels;

  // Batch-lookup team_ids for DM counterparts
  const userIds = [...new Set(dmChannels.map(ch => ch.user!))];
  const userTeamMap = new Map<string, string>();
  await Promise.all(userIds.slice(0, 50).map(async (uid) => {
    try {
      const { user } = await client.usersInfo(uid);
      if (user.team_id) userTeamMap.set(uid, user.team_id);
    } catch { /* skip */ }
  }));

  return channels.filter(ch => {
    if (!(ch.is_im) || !ch.user) return true; // non-DMs pass through
    const teamId = userTeamMap.get(ch.user);
    if (!teamId) return true; // couldn't resolve, allow through
    return rules.allowedOrgs.includes(teamId);
  });
}

/**
 * Filter a list of channels from conversations.list based on access rules.
 * Synchronous — uses only fields already present in the API response.
 */
export function filterChannelList(
  rules: SlackAccessRules,
  channels: Array<{
    id: string; name: string; is_private: boolean;
    is_ext_shared?: boolean; is_org_shared?: boolean;
    is_im?: boolean; is_mpim?: boolean;
    user?: string;
    shared_team_ids?: string[];
  }>,
): typeof channels {
  return channels.filter(ch => {
    const isDm = !!(ch.is_im || ch.is_mpim);

    if (isDm) {
      // DM: check user blacklist
      if (ch.user && rules.blacklistUsers.includes(ch.user)) return false;
      // Note: org check for DM counterparts requires async user lookup,
      // done in filterDmsByOrg() after this synchronous filter.
      return true;
    }

    // Channel checks
    if (rules.allowPublicOnly && ch.is_private) return false;

    const isShared = !!(ch.is_ext_shared || ch.is_org_shared);
    if (isShared && rules.allowedOrgs.length > 0 && ch.shared_team_ids) {
      const hasAllowedOrg = ch.shared_team_ids.some(tid => rules.allowedOrgs.includes(tid));
      if (!hasAllowedOrg) return false;
    }

    if (rules.whitelistChannels.length === 0) return false;
    if (!matchesAnyPattern(rules.whitelistChannels, ch.name)) return false;
    if (rules.blacklistChannels.length > 0 && matchesAnyPattern(rules.blacklistChannels, ch.name)) return false;

    return true;
  });
}
