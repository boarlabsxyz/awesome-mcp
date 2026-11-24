import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  compensationEmails,
  mayViewCompensation,
  requireCompensationAccessFor,
  COMPENSATION_RESTRICTED_MESSAGE,
} from '../../auth/compensationAccess.js';

let savedAdmin: string | undefined;
let savedComp: string | undefined;
beforeEach(() => {
  savedAdmin = process.env.ADMIN_EMAILS;
  savedComp = process.env.PEOPLEFORCE_COMPENSATION_EMAILS;
  delete process.env.ADMIN_EMAILS;
  delete process.env.PEOPLEFORCE_COMPENSATION_EMAILS;
});
afterEach(() => {
  if (savedAdmin === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedAdmin;
  if (savedComp === undefined) delete process.env.PEOPLEFORCE_COMPENSATION_EMAILS; else process.env.PEOPLEFORCE_COMPENSATION_EMAILS = savedComp;
});

describe('compensationEmails / mayViewCompensation', () => {
  it('parses case, whitespace and blank entries', () => {
    process.env.PEOPLEFORCE_COMPENSATION_EMAILS = ' Hr@Example.com , ,fin@example.com,, ';
    assert.deepEqual(compensationEmails(), ['hr@example.com', 'fin@example.com']);
    assert.equal(mayViewCompensation('HR@example.COM'), true);
    assert.equal(mayViewCompensation('  fin@example.com '), true);
    assert.equal(mayViewCompensation('other@example.com'), false);
  });

  it('lets admins through without being listed', () => {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    assert.equal(mayViewCompensation('Boss@example.com'), true);
  });

  it('with the list unset only admins pass', () => {
    process.env.ADMIN_EMAILS = 'boss@example.com';
    assert.equal(mayViewCompensation('hr@example.com'), false);
  });

  it('refuses non-string and blank emails, even with blank entries configured', () => {
    process.env.PEOPLEFORCE_COMPENSATION_EMAILS = 'hr@example.com,,';
    for (const bad of [undefined, null, 42, {}, '', '   ']) assert.equal(mayViewCompensation(bad), false);
  });
});

describe('requireCompensationAccessFor', () => {
  function fakeServer() {
    const added: any[] = [];
    const server: any = {
      addTool(t: any) { added.push(t); },
      addTools(ts: any[]) { added.push(...ts); },
    };
    return { server, added };
  }
  const mk = (name: string) => ({ name, execute: async () => `ran ${name}` });

  for (const via of ['addTool', 'addTools'] as const) {
    it(`guards only the named tools (${via})`, async () => {
      const { server, added } = fakeServer();
      requireCompensationAccessFor(server, new Set(['pay']));
      if (via === 'addTool') { server.addTool(mk('pay')); server.addTool(mk('other')); }
      else server.addTools([mk('pay'), mk('other')]);
      const [pay, other] = added;

      await assert.rejects(pay.execute({}, { session: { email: 'x@example.com' } }), { message: COMPENSATION_RESTRICTED_MESSAGE });
      await assert.rejects(pay.execute({}, {}), { message: COMPENSATION_RESTRICTED_MESSAGE });
      assert.equal(await other.execute({}, { session: { email: 'x@example.com' } }), 'ran other');

      process.env.PEOPLEFORCE_COMPENSATION_EMAILS = 'x@example.com';
      assert.equal(await pay.execute({}, { session: { email: 'X@example.com' } }), 'ran pay');
    });
  }
});
