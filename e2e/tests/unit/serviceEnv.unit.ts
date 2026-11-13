import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { serviceEnv } from '../../env.ts';

// The gate decides whether a check runs at all, so its failure mode is silent in
// both directions: a gate that always skips reports a green suite that asserted
// nothing, and one that never skips turns every unseeded service red.

const saved = { services: process.env.E2E_SERVICES, probe: process.env.E2E_PROBE_VAR };

afterEach(() => {
  for (const [key, value] of [['E2E_SERVICES', saved.services], ['E2E_PROBE_VAR', saved.probe]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('serviceEnv skips a service that is not listed', () => {
  delete process.env.E2E_SERVICES;
  const env = serviceEnv('slack');
  assert.match(String(env.skip), /slack is not listed in E2E_SERVICES/);
});

test('serviceEnv runs a listed service, and the baseline without listing', () => {
  process.env.E2E_SERVICES = 'clickup, slack';
  assert.equal(serviceEnv('slack').skip, false);
  delete process.env.E2E_SERVICES;
  assert.equal(serviceEnv('google-docs').skip, false);
  process.env.E2E_SERVICES = 'all';
  assert.equal(serviceEnv('hubspot').skip, false);
});

test('serviceEnv does not match a slug by prefix', () => {
  // 'slack-bot' listed must not enable 'slack' -- they hold different tokens.
  process.env.E2E_SERVICES = 'slack-bot';
  assert.notEqual(serviceEnv('slack').skip, false);
});

test('serviceEnv names every missing variable, and reads declared ones', () => {
  process.env.E2E_SERVICES = 'slack';
  delete process.env.E2E_PROBE_VAR;
  assert.match(String(serviceEnv('slack', ['E2E_PROBE_VAR']).skip), /unset: E2E_PROBE_VAR/);

  process.env.E2E_PROBE_VAR = 'value';
  const env = serviceEnv('slack', ['E2E_PROBE_VAR']);
  assert.equal(env.skip, false);
  assert.equal(env.get('E2E_PROBE_VAR'), 'value');
  assert.throws(() => env.get('E2E_UNDECLARED'), /was not declared/);
});
