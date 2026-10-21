import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbSource = await fs.readFile(path.join(__dirname, '..', 'db.ts'), 'utf-8');

/**
 * Source-level guard on the org DDL.
 *
 * initDatabase() takes no injectable pool, so there is no way to assert the
 * emitted SQL against a fake db the way peopleforceSnapshot.test.ts does with
 * ensureSnapshotTables. What can still be checked without Postgres is the one
 * failure this schema is actually exposed to: a DDL const that is declared and
 * never executed. That bug is silent — the table simply never exists, and every
 * org read returns empty as though nobody had created anything.
 */
const ORG_DDL_CONSTS = [
  'CREATE_ORGS_TABLE',
  'CREATE_ORG_DOMAINS_TABLE',
  'CREATE_ORG_MEMBERS_TABLE',
  'CREATE_ORG_MEMBERS_USER_INDEX',
  'CREATE_ORG_INVITES_TABLE',
  'CREATE_ORG_INVITES_ORG_INDEX',
];

describe('org schema DDL (src/db.ts)', () => {
  for (const name of ORG_DDL_CONSTS) {
    it(`${name} is declared and executed in initDatabase`, () => {
      assert.ok(
        new RegExp(`^const ${name} = \``, 'm').test(dbSource),
        `${name} is not declared`,
      );
      assert.ok(
        new RegExp(`await pool\\.query\\(${name}\\);`).test(dbSource),
        `${name} is declared but never executed — the table would silently never exist`,
      );
    });
  }

  it('every org table is created IF NOT EXISTS, so boot stays idempotent', () => {
    const tables = ['orgs', 'org_domains', 'org_members', 'org_invites'];
    for (const table of tables) {
      assert.ok(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(dbSource),
        `${table} is not created with IF NOT EXISTS`,
      );
    }
  });

  it('org tables cascade from users and orgs, so deleting either leaves no orphans', () => {
    for (const table of ['org_domains', 'org_members', 'org_invites']) {
      const block = dbSource.slice(dbSource.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      const body = block.slice(0, block.indexOf(');'));
      assert.match(body, /org_id\s+INTEGER NOT NULL REFERENCES orgs\(id\) ON DELETE CASCADE/);
    }
    const members = dbSource.slice(dbSource.indexOf('CREATE TABLE IF NOT EXISTS org_members'));
    assert.match(
      members.slice(0, members.indexOf(');')),
      /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    );
  });

  it('a domain is globally unique, so two orgs cannot both claim it', () => {
    const block = dbSource.slice(dbSource.indexOf('CREATE TABLE IF NOT EXISTS org_domains'));
    assert.match(block.slice(0, block.indexOf(');')), /domain\s+VARCHAR\(255\) NOT NULL UNIQUE/);
  });

  it('an invite stores a token hash and never a token', () => {
    const block = dbSource.slice(dbSource.indexOf('CREATE TABLE IF NOT EXISTS org_invites'));
    const body = block.slice(0, block.indexOf(');'));
    assert.match(body, /token_hash\s+CHAR\(64\) NOT NULL UNIQUE/);
    assert.ok(!/\btoken\s+(VARCHAR|TEXT|CHAR)/.test(body), 'no plaintext token column may exist');
  });

  it('one membership per (org, user)', () => {
    const block = dbSource.slice(dbSource.indexOf('CREATE TABLE IF NOT EXISTS org_members'));
    assert.match(block.slice(0, block.indexOf(');')), /UNIQUE\(org_id, user_id\)/);
  });

  it('the org tables are created after the users table they reference', () => {
    const usersAt = dbSource.indexOf('await pool.query(CREATE_USERS_TABLE);');
    const orgsAt = dbSource.indexOf('await pool.query(CREATE_ORGS_TABLE);');
    assert.ok(usersAt > -1 && orgsAt > -1);
    assert.ok(usersAt < orgsAt, 'orgs must be created after users, or the FK fails on a fresh database');
  });
});
