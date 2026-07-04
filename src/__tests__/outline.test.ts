// src/__tests__/outline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineServer } from '../outline/server.js';

test('outline server is registered', () => {
  assert.ok(outlineServer, 'server should be defined');
});
