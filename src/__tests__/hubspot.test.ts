// src/__tests__/hubspot.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotServer } from '../hubspot/server.js';

test('hubspot server is registered', () => {
  assert.ok(hubspotServer, 'server should be defined');
});
