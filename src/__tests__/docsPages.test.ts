import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The docs sidebar is hand-written static HTML, duplicated across every page,
 * so that the link graph survives with JavaScript disabled (a large share of
 * readers here are agents fetching a URL, which do not run JS).
 *
 * That duplication is the one thing a build step would have guaranteed for us.
 * These tests recover the guarantee: they read the committed HTML and assert
 * the pages agree with each other.
 */

const docsDir = path.resolve(process.cwd(), 'public', 'docs');

// Inert if run from an unexpected cwd, consistent with routes.test.ts's
// tolerance of environment differences.
const pages = fs.existsSync(docsDir)
  ? fs.readdirSync(docsDir).filter(f => f.endsWith('.html')).sort()
  : [];

function read(file: string): string {
  return fs.readFileSync(path.join(docsDir, file), 'utf8');
}

/** URL path a given file is served at: index.html -> /docs, x.html -> /docs/x. */
function urlFor(file: string): string {
  return file === 'index.html' ? '/docs' : `/docs/${file.replace(/\.html$/, '')}`;
}

/** Every /docs… href in the sidebar nav, in document order. */
function sidebarLinks(html: string): string[] {
  const nav = html.match(/<aside class="docs-sidebar"[\s\S]*?<\/aside>/);
  if (!nav) return [];
  return Array.from(nav[0].matchAll(/href="(\/docs[^"]*)"/g)).map(m => m[1]);
}

describe('docs pages', () => {
  it('finds the committed docs pages', () => {
    if (!pages.length) return;
    assert.ok(pages.includes('index.html'), 'public/docs/index.html must exist');
    assert.ok(pages.includes('404.html'), 'public/docs/404.html must exist');
  });

  for (const file of pages) {
    describe(file, () => {
      it('links the shared stylesheet and script', () => {
        const html = read(file);
        assert.match(html, /href="\/docs\/docs\.css"/);
        assert.match(html, /src="\/docs\/docs\.js"/);
      });

      it('marks exactly one nav link as the current page, and it is this page', () => {
        const html = read(file);
        const current = Array.from(html.matchAll(/href="(\/docs[^"]*)"[^>]*aria-current="page"/g));
        if (file === '404.html') {
          // 404 is not in the nav, so nothing should claim to be current.
          assert.equal(current.length, 0, '404.html must not mark a nav link current');
          return;
        }
        assert.equal(current.length, 1, `expected 1 aria-current="page", got ${current.length}`);
        assert.equal(current[0][1], urlFor(file));
      });

      it('gives every content heading an id, so the TOC can see it', () => {
        const html = read(file);
        const main = html.match(/<main[\s\S]*?<\/main>/);
        assert.ok(main, 'page must have a <main>');
        for (const m of main![0].matchAll(/<(h2|h3)([^>]*)>/g)) {
          assert.match(m[2], /\sid="/, `<${m[1]}> without an id: ${m[0]}`);
        }
      });

      it('references only media files that exist on disk', () => {
        const html = read(file);
        const refs = Array.from(html.matchAll(/(?:src|poster)="(\/docs\/media\/[^"]+)"/g));
        for (const [, ref] of refs) {
          const onDisk = path.join(docsDir, 'media', path.basename(ref));
          assert.ok(fs.existsSync(onDisk), `${file} references missing media ${ref}`);
        }
      });
    });
  }

  it('every page carries an identical sidebar', () => {
    const navPages = pages.filter(f => f !== '404.html');
    if (navPages.length < 2) return;
    const reference = sidebarLinks(read(navPages[0]));
    assert.ok(reference.length > 0, 'sidebar produced no links');
    for (const file of navPages.slice(1)) {
      assert.deepEqual(
        sidebarLinks(read(file)), reference,
        `${file}'s sidebar differs from ${navPages[0]}'s — a link was added or removed in only some pages`,
      );
    }
  });

  it('every sidebar link resolves to a committed page', () => {
    if (!pages.length) return;
    const served = new Set(pages.map(urlFor));
    for (const href of sidebarLinks(read('index.html'))) {
      assert.ok(served.has(href), `sidebar links ${href}, which no page serves`);
    }
  });

  it('every page is reachable from the sidebar', () => {
    if (!pages.length) return;
    const linked = new Set(sidebarLinks(read('index.html')));
    for (const file of pages) {
      if (file === '404.html') continue;   // deliberately not in the nav
      assert.ok(linked.has(urlFor(file)), `${file} is orphaned — no sidebar link points at it`);
    }
  });
});
