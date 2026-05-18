#!/usr/bin/env node
// Generates release notes in three formats: Slack text, HTML block for updates.html, and HTML email.
// No external dependencies — uses only Node.js builtins.

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

if (!tag || !commitsFile || !outputDir) {
  console.error('Usage: generate-release-notes.mjs --tag <tag> --commits <file> --tasks <file> --output-dir <dir>');
  process.exit(1);
}

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

const commits = parseCommits(commitsFile);
const tasks = tasksFile ? parseTasks(tasksFile) : new Map();

// --- Categorize commits by conventional commit type ---
const categories = { feat: [], fix: [], other: [] };
const typeRegex = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\(.+?\))?!?:\s*/;

// Internal commit types not shown to users
const internalTypes = new Set(['ci', 'chore', 'test', 'docs', 'style', 'refactor', 'revert']);

for (const commit of commits) {
  const match = commit.subject.match(typeRegex);
  const type = match ? match[1] : null;

  // Skip internal/technical commits
  if (type && internalTypes.has(type)) continue;

  // Strip CU- references from display text
  const cleanSubject = commit.subject
    .replace(typeRegex, '')
    .replace(/\s*CU-[a-z0-9]+/gi, '')
    .trim();

  // Extract CU- references from subject + body for ClickUp lookup
  const fullText = `${commit.subject} ${commit.body}`;
  const cuMatches = [...fullText.matchAll(/CU-([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
  const uniqueIds = [...new Set(cuMatches)];

  const entry = { ...commit, cleanSubject, taskIds: uniqueIds };

  if (type === 'feat') categories.feat.push(entry);
  else if (type === 'fix') categories.fix.push(entry);
  else categories.other.push(entry);
}

// --- Find tasks not linked to any commit (e.g. CU- IDs only in merge commits) ---
const linkedTaskIds = new Set();
for (const list of Object.values(categories)) {
  for (const entry of list) {
    for (const id of entry.taskIds) linkedTaskIds.add(id);
  }
}
const unlinkedTasks = [...tasks.entries()]
  .filter(([id]) => !linkedTaskIds.has(id))
  .map(([id, info]) => ({ id, ...info }));

// --- Determine primary tag ---
let primaryTag = 'improvement';
if (categories.feat.length > 0) primaryTag = 'feature';
else if (categories.fix.length > 0) primaryTag = 'fix';

// --- Helpers ---
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function enrichWithTasks(entry, format) {
  let text = format === 'html' ? escapeHtml(entry.cleanSubject) : entry.cleanSubject;
  for (const id of entry.taskIds) {
    const task = tasks.get(id);
    if (task) {
      if (format === 'html') {
        text += ` (<a href="${escapeHtml(task.url)}">${escapeHtml(task.title)}</a>)`;
      } else if (format === 'slack') {
        text += ` (<${task.url}|${task.title}>)`;
      } else {
        text += ` (${task.title})`;
      }
    }
  }
  return text;
}

// --- Generate Slack message ---
function generateSlack() {
  const lines = [`*${tag}* — ${formatDate()}\n`];

  if (categories.feat.length) {
    lines.push('*What\'s New*');
    for (const e of categories.feat) lines.push(`• ${enrichWithTasks(e, 'slack')}`);
    lines.push('');
  }
  if (categories.fix.length) {
    lines.push('*Bug Fixes*');
    for (const e of categories.fix) lines.push(`• ${enrichWithTasks(e, 'slack')}`);
    lines.push('');
  }
  if (categories.other.length) {
    lines.push('*Improvements*');
    for (const e of categories.other) lines.push(`• ${enrichWithTasks(e, 'slack')}`);
    lines.push('');
  }
  if (unlinkedTasks.length) {
    lines.push('*Related Tasks*');
    for (const t of unlinkedTasks) lines.push(`• <${t.url}|${t.title}>`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// --- Generate HTML block for updates.html ---
function generateHtmlBlock() {
  const date = formatDate();
  const tagClass = primaryTag === 'feature' ? 'tag-feature' : primaryTag === 'fix' ? 'tag-fix' : 'tag-improvement';
  const tagLabel = primaryTag === 'feature' ? 'Feature' : primaryTag === 'fix' ? 'Fix' : 'Improvement';

  let html = '';
  html += `    <div class="release">\n`;
  html += `      <div class="release-header">\n`;
  html += `        <span class="release-version">${escapeHtml(tag)}</span>\n`;
  html += `        <span class="release-date">${date}</span>\n`;
  html += `        <span class="release-tag ${tagClass}">${tagLabel}</span>\n`;
  html += `      </div>\n`;
  html += `      <div class="release-body">\n`;

  if (categories.feat.length) {
    html += `        <h3>What's New</h3>\n        <ul>\n`;
    for (const e of categories.feat) html += `          <li>${enrichWithTasks(e, 'html')}</li>\n`;
    html += `        </ul>\n`;
  }
  if (categories.fix.length) {
    html += `        <h3>Bug Fixes</h3>\n        <ul>\n`;
    for (const e of categories.fix) html += `          <li>${enrichWithTasks(e, 'html')}</li>\n`;
    html += `        </ul>\n`;
  }
  if (categories.other.length) {
    html += `        <h3>Improvements</h3>\n        <ul>\n`;
    for (const e of categories.other) html += `          <li>${enrichWithTasks(e, 'html')}</li>\n`;
    html += `        </ul>\n`;
  }
  if (unlinkedTasks.length) {
    html += `        <h3>Related Tasks</h3>\n        <ul>\n`;
    for (const t of unlinkedTasks) html += `          <li><a href="${escapeHtml(t.url)}">${escapeHtml(t.title)}</a></li>\n`;
    html += `        </ul>\n`;
  }

  html += `      </div>\n`;
  html += `    </div>\n`;
  return html;
}

// --- Generate HTML email body ---
function generateEmail() {
  const date = formatDate();
  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #111; color: #ededed; padding: 32px; border-radius: 8px;">`;
  html += `<h1 style="font-size: 24px; margin: 0 0 4px;">Awesome MCP ${escapeHtml(tag)}</h1>`;
  html += `<p style="color: #888; font-size: 14px; margin: 0 0 24px;">${date}</p>`;

  if (categories.feat.length) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">What's New</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const e of categories.feat) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;">${enrichWithTasks(e, 'html')}</li>`;
    html += `</ul>`;
  }
  if (categories.fix.length) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">Bug Fixes</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const e of categories.fix) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;">${enrichWithTasks(e, 'html')}</li>`;
    html += `</ul>`;
  }
  if (categories.other.length) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">Improvements</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const e of categories.other) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;">${enrichWithTasks(e, 'html')}</li>`;
    html += `</ul>`;
  }
  if (unlinkedTasks.length) {
    html += `<h2 style="font-size: 16px; color: #888; text-transform: uppercase; letter-spacing: 0.03em; margin: 20px 0 8px;">Related Tasks</h2><ul style="padding-left: 20px; margin: 0;">`;
    for (const t of unlinkedTasks) html += `<li style="color: #ccc; margin-bottom: 6px; line-height: 1.5;"><a href="${escapeHtml(t.url)}" style="color: #0070f3;">${escapeHtml(t.title)}</a></li>`;
    html += `</ul>`;
  }

  html += `<hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">`;
  html += `<p style="color: #666; font-size: 12px; margin: 0;">You're receiving this because you have an Awesome MCP account.</p>`;
  html += `</div>`;
  return html;
}

// --- Write outputs ---
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'slack-message.txt'), generateSlack());
writeFileSync(join(outputDir, 'updates-block.html'), generateHtmlBlock());
writeFileSync(join(outputDir, 'email-body.html'), generateEmail());

console.log(`Release notes generated for ${tag}`);
console.log(`  Commits: ${commits.length} (${categories.feat.length} feat, ${categories.fix.length} fix, ${categories.other.length} other)`);
console.log(`  ClickUp tasks resolved: ${tasks.size}`);
