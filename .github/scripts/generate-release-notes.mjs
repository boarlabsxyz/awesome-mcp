#!/usr/bin/env node
// Generates release notes in three formats: Slack text, HTML block for updates.html, and HTML email.
// No external dependencies — uses only Node.js builtins.
//
// Content strategy:
//   1. If OPENROUTER_API_KEY is set, send raw commits + ClickUp task titles to Claude (via
//      OpenRouter) and ask it to produce a user-facing summary (drops chores/refactors/CI/
//      deps/internal fixes/admin-side changes, rewrites commit-speak into plain English).
//      Claude decides sections + primaryTag.
//   2. Otherwise (or on API failure) fall back to conventional-commit categorization so the
//      workflow never breaks on network hiccups or a missing key.
//   3. Either way, connectors whose OAuth scopes grew (--scope-changes, written by
//      detect-scope-changes.mjs) get an "Action needed" reconnect section. It is added
//      here rather than left to the model, so it can't be filtered out or reworded away.
//
// We use OpenRouter rather than the Anthropic API directly so the same key can be
// re-routed to a different provider/model in the future by editing OPENROUTER_MODEL below
// without touching secrets.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const tag = getArg('tag');
const commitsFile = getArg('commits');
const tasksFile = getArg('tasks');
const outputDir = getArg('output-dir');
const dateArg = getArg('date');
const scopeChangesFile = getArg('scope-changes');

if (!tag || !commitsFile || !outputDir) {
  console.error('Usage: generate-release-notes.mjs --tag <tag> --commits <file> --tasks <file> --output-dir <dir> [--date <ISO>] [--scope-changes <file>]');
  process.exit(1);
}

// Resolve the release date once: explicit --date (ISO 8601) wins, else now.
// Fixing this up front makes the workflow output reproducible across runs
// (e.g. release-notes.yml regenerating notes for a tag the next day).
const releaseDate = (() => {
  if (!dateArg) return new Date();
  const d = new Date(dateArg);
  if (isNaN(d.getTime())) {
    console.error(`Invalid --date "${dateArg}"`);
    process.exit(1);
  }
  return d;
})();

// --- Parse inputs ---
function parseCommits(file) {
  const content = readFileSync(file, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(line => {
    const [hash, subject, ...bodyParts] = line.split('|');
    return { hash: hash?.trim(), subject: subject?.trim() || '', body: bodyParts.join('|').trim() };
  });
}

function parseTasks(file) {
  try {
    const content = readFileSync(file, 'utf8').trim();
    if (!content) return new Map();
    const map = new Map();
    for (const line of content.split('\n').filter(Boolean)) {
      const [id, title, url] = line.split('|');
      if (id && title) map.set(id.trim(), { title: title.trim(), url: url?.trim() || '' });
    }
    return map;
  } catch {
    return new Map();
  }
}

// [{ slug, name, added }] from detect-scope-changes.mjs. A missing or unreadable file
// means no reconnect section, never a failed release.
function parseScopeChanges(file) {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(c => c && typeof c.name === 'string' && Array.isArray(c.added) && c.added.length) : [];
  } catch (err) {
    console.warn(`Could not read scope changes from ${file}: ${err.message}. No reconnect section.`);
    return [];
  }
}

const commits = parseCommits(commitsFile);
const tasks = tasksFile ? parseTasks(tasksFile) : new Map();
const scopeChanges = parseScopeChanges(scopeChangesFile);

// --- Extract CU- ids and clean subjects (shared between AI + fallback paths) ---
const typeRegex = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\(.+?\))?!?:\s*/;

function extractTaskIds(commit) {
  const fullText = `${commit.subject} ${commit.body}`;
  const matches = [...fullText.matchAll(/CU-([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
  return [...new Set(matches)];
}

function cleanSubject(subject) {
  return subject.replace(typeRegex, '').replace(/\s*CU-[a-z0-9]+/gi, '').trim();
}

// --- Connector labels: every bullet says which connector it is about ---
// The names people see on the dashboard, minus "MCP". 'Website' is the site and dashboard
// themselves; 'All connectors' is a change every connector gets at once.
const CONNECTORS = [
  'Google Docs', 'Google Sheets', 'Google Slides', 'Google Drive', 'Gmail', 'Google Calendar',
  'Slack', 'ClickUp', 'HubSpot', 'Outline', 'PeopleForce', 'Redmine', 'GitHub',
  'Browserbase', 'Pinecone', 'Supabase', 'Storage', 'Sandbox', 'Website', 'All connectors',
];

// Conventional-commit scope -> label, for the fallback path. Unknown scopes get no label.
const SCOPE_CONNECTORS = {
  docs: 'Google Docs', 'google-docs': 'Google Docs', sheets: 'Google Sheets', 'google-sheets': 'Google Sheets',
  slides: 'Google Slides', 'google-slides': 'Google Slides', drive: 'Google Drive', 'google-drive': 'Google Drive',
  gmail: 'Gmail', 'google-gmail': 'Gmail', calendar: 'Google Calendar', 'google-calendar': 'Google Calendar',
  slack: 'Slack', 'slack-user': 'Slack', 'slack-bot': 'Slack', clickup: 'ClickUp', hubspot: 'HubSpot',
  outline: 'Outline', peopleforce: 'PeopleForce', 'peopleforce-v4': 'PeopleForce', redmine: 'Redmine',
  github: 'GitHub', browserbase: 'Browserbase', pinecone: 'Pinecone', supabase: 'Supabase',
  storage: 'Storage', sandbox: 'Sandbox', dashboard: 'Website', website: 'Website', ui: 'Website',
  integrations: 'Website',
};

function normalizeConnector(name) {
  if (typeof name !== 'string') return null;
  return CONNECTORS.find(c => c.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

// "feat(slack,docs): ..." -> "Slack, Google Docs"
function connectorFromSubject(subject) {
  const scope = subject.match(typeRegex)?.[2]?.slice(1, -1);
  if (!scope) return null;
  const names = [...new Set(scope.split(',').map(s => SCOPE_CONNECTORS[s.trim().toLowerCase()]).filter(Boolean))];
  return names.length ? names.join(', ') : null;
}

// Same-connector bullets next to each other, connectors in order of first appearance.
function groupByConnector(items) {
  const order = [...new Set(items.map(it => it.connector ?? ''))];
  return [...items].sort((a, b) => order.indexOf(a.connector ?? '') - order.indexOf(b.connector ?? ''));
}

// --- Normalized shape both paths produce ---
// { primaryTag: 'feature'|'fix'|'improvement', sections: [{heading, items: [{text, taskIds}]}] }

// --- AI-driven summary (Claude via OpenRouter) ---
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

async function generateFromAI() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (commits.length === 0) return null;

  // Compact commit list. Body is included but truncated — Claude only needs enough
  // to judge whether a commit is user-facing, not the full patch context.
  const commitLines = commits.map(c => {
    const body = c.body ? c.body.slice(0, 400) : '';
    const ids = extractTaskIds(c);
    const idPart = ids.length ? ` [CU: ${ids.join(', ')}]` : '';
    return body
      ? `- ${c.subject}${idPart}\n    ${body}`
      : `- ${c.subject}${idPart}`;
  }).join('\n');

  const taskLines = tasks.size
    ? [...tasks.entries()].map(([id, t]) => `- CU-${id}: ${t.title}`).join('\n')
    : '(none)';

  const reconnectLines = scopeChanges.length
    ? scopeChanges.map(c => `- ${c.name}: ${c.added.join(', ')}`).join('\n')
    : '(none)';

  const systemPrompt = [
    'You write release notes for Awesome MCP, a hosted platform that gives Claude and ChatGPT users access to their Google Docs, Sheets, Calendar, Drive, Outline wiki, ClickUp, PeopleForce HR, and other services through MCP.',
    'Readers are non-technical end users. They care about:',
    '  - New integrations or services now available',
    '  - New capabilities on an existing integration (e.g. "Docs can now export to PDF")',
    '  - New pages, UI, or design changes on the website',
    '  - Bug fixes that USERS actually notice (a feature that was broken now works)',
    'They do NOT care about:',
    '  - Internal refactors, dependency bumps, CI, tests, build tooling, lint fixes',
    '  - Backend plumbing, code cleanup, log-line tweaks, type-safety changes',
    '  - Bug fixes to internal-only or already-invisible behavior',
    '  - Admin-side changes: the /admin page, the Admin MCP, usage analytics, and any tool, setting, or fix only platform admins can see',
    '  - Anything a user would not have noticed if it were absent from the notes',
    'Rewrite commit messages into plain, friendly English. Never mention commit prefixes (feat/fix/chore), file paths, function names, PR numbers, or CU- ticket ids in the text.',
  ].join('\n');

  const userPrompt = [
    `Release: ${tag}`,
    '',
    'Commits in this release:',
    commitLines,
    '',
    'Related ClickUp task titles (for extra context; not all are user-facing):',
    taskLines,
    '',
    'Connectors that ask for new permissions in this release (existing connections must be reconnected to use what they unlock):',
    reconnectLines,
    '',
    'Produce ONE JSON object (no markdown fences, no prose before or after) that matches this schema exactly:',
    '{',
    '  "hasUserFacingChanges": boolean,',
    '  "primaryTag": "feature" | "fix" | "improvement",',
    '  "sections": [',
    '    {',
    '      "heading": string,   // e.g. "What\'s New", "New Integrations", "Bug Fixes", "Improvements"',
    '      "items": [',
    '        { "text": string, "connector": string, "clickupIds": [string] }   // clickupIds are the CU-... ids (without prefix) this bullet relates to; may be []',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- If nothing in the commit list is user-facing, set hasUserFacingChanges to false, primaryTag to "improvement", and sections to an empty array.',
    '- Filter aggressively. Prefer omitting a bullet to including a technical one.',
    '- Omit every admin-side change, including new features and bug fixes, and treat commits scoped to admin, admin-mcp, or usage as admin-side. If a commit mixes admin-side and user-facing work, describe only the user-facing part.',
    '- "Admin" here means platform admins only. Keep changes that affect regular users, even if the word appears (e.g. "Fixed Redmine time entries not loading for non-admin accounts").',
    '- primaryTag = "feature" if any new capability, else "fix" if only user-visible bug fixes, else "improvement".',
    `- connector is exactly one of: ${CONNECTORS.join(', ')}. Use "Website" for the site and dashboard, and "All connectors" only for a change every connector gets.`,
    '- Each bullet is about ONE connector. A change to two connectors is two bullets; never merge items from different connectors.',
    '- The connector is shown as a label before the text, so do not start the text with the connector name (write "Reply drafts stay in the original thread", not "Gmail: reply drafts...").',
    '- Group related items for the same connector under one bullet where sensible (e.g. "Added PDF export and page-break support" rather than two bullets).',
    '- Keep bullets short — one line each, no trailing period required.',
    '- Do not write reconnect instructions or name permission scopes. An "Action needed" section telling people to reconnect the connectors listed above is added after your output. A feature bullet may end with "(reconnect to use it)" when it depends on one of those connectors.',
  ].join('\n');

  console.log(`Calling ${OPENROUTER_MODEL} via OpenRouter to summarize ${commits.length} commit(s)...`);

  // Bound the call so a stuck upstream can't run out the workflow's 6h job timeout.
  // Fallback categorization is cheap; failing fast is preferable to hanging the release.
  const OPENROUTER_TIMEOUT_MS = 60_000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for their attribution/rankings page; harmless if omitted.
        'HTTP-Referer': 'https://github.com/boarlabsxyz/awesome-mcp',
        'X-Title': 'awesome-mcp release notes',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 2048,
        temperature: 0,
        // Hint to providers that support it (OpenAI, some others). Anthropic ignores
        // it, which is why the prompt also spells out "no markdown fences, no prose".
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timed out after ${OPENROUTER_TIMEOUT_MS}ms`
      : `network: ${err.message}`;
    console.warn(`OpenRouter request failed (${reason}). Falling back to deterministic categorization.`);
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.warn(`OpenRouter returned HTTP ${response.status}. Body: ${errBody.slice(0, 500)}`);
    console.warn('Falling back to deterministic categorization.');
    return null;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    console.warn(`Could not parse OpenRouter response as JSON envelope: ${err.message}. Falling back.`);
    return null;
  }

  const rawText = payload?.choices?.[0]?.message?.content;
  if (typeof rawText !== 'string') {
    console.warn('OpenRouter response missing choices[0].message.content. Falling back.');
    return null;
  }

  // Defensive: strip ```json fences if the model wrapped its output, then find the outer
  // JSON object. Anthropic-via-OpenRouter usually returns bare JSON but this is cheap.
  const jsonText = (() => {
    const stripped = rawText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    return firstBrace !== -1 && lastBrace > firstBrace ? stripped.slice(firstBrace, lastBrace + 1) : stripped;
  })();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.warn(`Model returned malformed JSON: ${err.message}. Raw text: ${rawText.slice(0, 300)}`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.warn('Claude JSON was not an object. Falling back.');
    return null;
  }

  if (parsed.hasUserFacingChanges === false) {
    console.log('Model determined no user-facing changes in this release.');
    return { primaryTag: 'improvement', sections: [], empty: true };
  }

  const primaryTag = ['feature', 'fix', 'improvement'].includes(parsed.primaryTag) ? parsed.primaryTag : 'improvement';
  const sections = Array.isArray(parsed.sections) ? parsed.sections
    .filter(s => s && typeof s.heading === 'string' && Array.isArray(s.items) && s.items.length > 0)
    .map(s => ({
      heading: s.heading.trim(),
      items: groupByConnector(s.items
        .filter(it => it && typeof it.text === 'string' && it.text.trim())
        .map(it => ({
          text: it.text.trim(),
          connector: normalizeConnector(it.connector),
          taskIds: Array.isArray(it.clickupIds) ? it.clickupIds.map(id => String(id).toLowerCase()) : [],
        }))),
    }))
    .filter(s => s.items.length > 0) : [];

  if (sections.length === 0) {
    console.warn('Model returned no usable sections. Falling back.');
    return null;
  }

  console.log(`Model produced ${sections.length} section(s), ${sections.reduce((n, s) => n + s.items.length, 0)} bullet(s).`);
  return { primaryTag, sections };
}

// --- Deterministic fallback: conventional-commit categorization ---
function generateFromCommits() {
  const feat = [];
  const fix = [];
  const other = [];
  const internalTypes = new Set(['ci', 'chore', 'test', 'docs', 'style', 'refactor', 'revert']);

  for (const commit of commits) {
    const match = commit.subject.match(typeRegex);
    const type = match ? match[1] : null;
    if (type && internalTypes.has(type)) continue;

    const item = { text: cleanSubject(commit.subject), connector: connectorFromSubject(commit.subject), taskIds: extractTaskIds(commit) };
    if (!item.text) continue;
    if (type === 'feat') feat.push(item);
    else if (type === 'fix') fix.push(item);
    else other.push(item);
  }

  const sections = [];
  if (feat.length) sections.push({ heading: "What's New", items: groupByConnector(feat) });
  if (fix.length) sections.push({ heading: 'Bug Fixes', items: groupByConnector(fix) });
  if (other.length) sections.push({ heading: 'Improvements', items: groupByConnector(other) });

  const primaryTag = feat.length ? 'feature' : fix.length ? 'fix' : 'improvement';
  return { primaryTag, sections };
}

// --- Reconnect section (deterministic, appended to either path) ---
function reconnectSection() {
  if (scopeChanges.length === 0) return null;
  return {
    heading: 'Action needed',
    items: scopeChanges.map(c => ({
      text: `Reconnect ${c.name} from your dashboard: some new features need extra permissions, and an existing connection keeps the old ones until you reconnect`,
      taskIds: [],
    })),
  };
}

// --- Helpers ---
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate() {
  // timeZone: 'UTC' so a midnight-UTC --date never rolls back a day in west-of-UTC runners.
  return releaseDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function enrichWithTasks(item, format) {
  let text = format === 'html' ? escapeHtml(item.text) : item.text;
  if (item.connector) {
    text = format === 'html' ? `<strong>${escapeHtml(item.connector)}:</strong> ${text}`
      : format === 'slack' ? `*${item.connector}:* ${text}`
      : `${item.connector}: ${text}`;
  }
  for (const id of item.taskIds) {
    const task = tasks.get(id);
    if (!task) continue;
    if (format === 'html') text += ` (<a href="${escapeHtml(task.url)}">${escapeHtml(task.title)}</a>)`;
    else if (format === 'slack') text += ` (<${task.url}|${task.title}>)`;
    else text += ` (${task.title})`;
  }
  return text;
}

// --- Find tasks not linked to any bullet (so they still appear somewhere) ---
function computeUnlinkedTasks(summary) {
  const linked = new Set();
  for (const section of summary.sections) {
    for (const item of section.items) {
      for (const id of item.taskIds) linked.add(id);
    }
  }
  return [...tasks.entries()]
    .filter(([id]) => !linked.has(id))
    .map(([id, info]) => ({ id, ...info }));
}

// --- Output generators ---
function generateSlack(summary, unlinked) {
  const lines = [`*${tag}* — ${formatDate()}\n`];
  for (const section of summary.sections) {
    lines.push(`*${section.heading}*`);
    for (const item of section.items) lines.push(`• ${enrichWithTasks(item, 'slack')}`);
    lines.push('');
  }
  if (unlinked.length) {
    lines.push('*Related Tasks*');
    for (const t of unlinked) lines.push(`• <${t.url}|${t.title}>`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function generateHtmlBlock(summary, unlinked) {
  const date = formatDate();
  const tagClass = summary.primaryTag === 'feature' ? 'tag-feature' : summary.primaryTag === 'fix' ? 'tag-fix' : 'tag-improvement';
  const tagLabel = summary.primaryTag === 'feature' ? 'Feature' : summary.primaryTag === 'fix' ? 'Fix' : 'Improvement';

  let html = '';
  html += `    <div class="release">\n`;
  html += `      <div class="release-header">\n`;
  html += `        <span class="release-version">${escapeHtml(tag)}</span>\n`;
  html += `        <span class="release-date">${date}</span>\n`;
  html += `        <span class="release-tag ${tagClass}">${tagLabel}</span>\n`;
  html += `      </div>\n`;
  html += `      <div class="release-body">\n`;

  for (const section of summary.sections) {
    html += `        <h3>${escapeHtml(section.heading)}</h3>\n        <ul>\n`;
    for (const item of section.items) html += `          <li>${enrichWithTasks(item, 'html')}</li>\n`;
    html += `        </ul>\n`;
  }
  if (unlinked.length) {
    html += `        <h3>Related Tasks</h3>\n        <ul>\n`;
    for (const t of unlinked) html += `          <li><a href="${escapeHtml(t.url)}">${escapeHtml(t.title)}</a></li>\n`;
    html += `        </ul>\n`;
  }

  html += `      </div>\n`;
  html += `    </div>\n`;
  return html;
}

function generateEmail(summary, unlinked) {
  const date = formatDate();
  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #111; color: #ededed; padding: 32px; border-radius: 8px;">`;
  html += `<h1 style="font-size: 24px; margin: 0 0 4px;">Awesome MCP ${escapeHtml(tag)}</h1>`;
  html += `<p style="color: #888; font-size: 14px; margin: 0 0 24px;">${date}</p>`;

  for (const section of summary.sections) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">${escapeHtml(section.heading)}</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const item of section.items) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;">${enrichWithTasks(item, 'html')}</li>`;
    html += `</ul>`;
  }
  if (unlinked.length) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">Related Tasks</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const t of unlinked) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;"><a href="${escapeHtml(t.url)}" style="color: #0070f3;">${escapeHtml(t.title)}</a></li>`;
    html += `</ul>`;
  }

  html += `<hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">`;
  html += `<p style="color: #666; font-size: 12px; margin: 0;">You're receiving this because you have an Awesome MCP account.</p>`;
  html += `</div>`;
  return html;
}

// --- Main ---
const summary = (await generateFromAI()) ?? generateFromCommits();

// First, so it is the first thing read. A release whose only user-facing change is a
// new scope still has something to say.
const reconnect = reconnectSection();
if (reconnect) {
  summary.sections = [reconnect, ...summary.sections];
  delete summary.empty;
}

// Nothing user-facing means nothing to publish. The workflows treat a missing output
// file as "skip this channel", so write none of them.
if (summary.empty) {
  console.log(`No release notes generated for ${tag}: no user-facing changes.`);
  process.exit(0);
}

const unlinkedTasks = computeUnlinkedTasks(summary);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'slack-message.txt'), generateSlack(summary, unlinkedTasks));
writeFileSync(join(outputDir, 'updates-block.html'), generateHtmlBlock(summary, unlinkedTasks));
writeFileSync(join(outputDir, 'email-body.html'), generateEmail(summary, unlinkedTasks));

const totalBullets = summary.sections.reduce((n, s) => n + s.items.length, 0);
console.log(`Release notes generated for ${tag}`);
console.log(`  Commits analyzed: ${commits.length}`);
console.log(`  Bullets in output: ${totalBullets} across ${summary.sections.length} section(s)`);
console.log(`  ClickUp tasks resolved: ${tasks.size}`);
