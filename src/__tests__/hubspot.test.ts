// src/__tests__/hubspot.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hubspotServer,
  createCompanySchema,
  createContactSchema,
  createDealSchema,
  createNoteSchema,
  logCallSchema,
  logMeetingSchema,
} from '../hubspot/server.js';

test('hubspot server is registered', () => {
  assert.ok(hubspotServer, 'server should be defined');
});

// These six schemas are the mechanism that keeps POST /api/v1/hubspot/* and the
// MCP write tools from drifting: the route validates req.body with the very
// object the tool declares as its `parameters`. REST bypasses FastMCP's Zod
// layer entirely, so if one of these stops rejecting a bad body, the HTTP
// surface silently starts accepting one the tool would refuse.
describe('write schemas reused by the REST siblings', () => {
  test('createCompanySchema requires a name', () => {
    assert.equal(createCompanySchema.safeParse({}).success, false);
    assert.equal(createCompanySchema.safeParse({ name: 'Acme' }).success, true);
    assert.equal(createCompanySchema.safeParse({ name: 'Acme', properties: { domain: 'acme.test' } }).success, true);
  });

  test('createContactSchema requires both names, email is optional', () => {
    assert.equal(createContactSchema.safeParse({ firstname: 'Ada' }).success, false);
    assert.equal(createContactSchema.safeParse({ firstname: 'Ada', lastname: 'Lovelace' }).success, true);
  });

  test('createDealSchema requires a dealname', () => {
    assert.equal(createDealSchema.safeParse({}).success, false);
    assert.equal(createDealSchema.safeParse({ dealname: 'Q4 renewal' }).success, true);
  });

  test('createNoteSchema requires a body', () => {
    assert.equal(createNoteSchema.safeParse({}).success, false);
    assert.equal(createNoteSchema.safeParse({ body: 'Called back.' }).success, true);
  });

  // Half a target is worse than none: HubSpot would create the engagement and
  // then have nothing to attach it to, leaving it orphaned off every timeline.
  test('the engagement schemas reject half an association target', () => {
    for (const schema of [createNoteSchema, logCallSchema, logMeetingSchema]) {
      assert.equal(schema.safeParse({ body: 'x', associateToObjectType: 'companies' }).success, false);
      assert.equal(schema.safeParse({ body: 'x', associateToObjectId: '123' }).success, false);
      assert.equal(
        schema.safeParse({ body: 'x', associateToObjectType: 'companies', associateToObjectId: '123' }).success,
        true,
      );
      assert.equal(schema.safeParse({ body: 'x' }).success, true);
    }
  });

  test('logCallSchema constrains direction to the two HubSpot values', () => {
    assert.equal(logCallSchema.safeParse({ direction: 'SIDEWAYS' }).success, false);
    assert.equal(logCallSchema.safeParse({ direction: 'INBOUND' }).success, true);
  });

  // hs_timestamp is documented as either an ISO-8601 string or epoch millis, and
  // the REST route forwards whichever arrives untouched.
  test('logMeetingSchema accepts ISO or epoch-millis times', () => {
    assert.equal(logMeetingSchema.safeParse({ startTime: '2026-09-27T10:00:00Z' }).success, true);
    assert.equal(logMeetingSchema.safeParse({ startTime: 1790000000000 }).success, true);
    assert.equal(logMeetingSchema.safeParse({ startTime: { at: 'noon' } }).success, false);
  });
});
