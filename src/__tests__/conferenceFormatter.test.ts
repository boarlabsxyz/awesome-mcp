import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMeetConferenceData,
  formatConferenceCompact,
  formatConferenceDetail,
  formatMeetPendingHint,
  hasExistingConference,
} from '../google-calendar/conferenceFormatter.js';

describe('formatConferenceCompact', () => {
  it('returns empty string when event has no conferencing', () => {
    assert.equal(formatConferenceCompact({ summary: 'plain' } as any), '');
  });

  it('prefers hangoutLink over conferenceData entry points', () => {
    const out = formatConferenceCompact({
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      conferenceData: {
        conferenceSolution: { name: 'Zoom Meeting' },
        entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123' }],
      },
    } as any);
    assert.equal(out, '   Meet: https://meet.google.com/abc-defg-hij\n');
  });

  it('falls back to the first video entry point when hangoutLink is absent', () => {
    const out = formatConferenceCompact({
      conferenceData: {
        conferenceSolution: { name: 'Zoom Meeting' },
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
          { entryPointType: 'video', uri: 'https://zoom.us/j/123' },
        ],
      },
    } as any);
    assert.equal(out, '   Zoom Meeting: https://zoom.us/j/123\n');
  });

  it('labels with "Conference" when the solution name is missing', () => {
    const out = formatConferenceCompact({
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://example.com/v/1' }],
      },
    } as any);
    assert.equal(out, '   Conference: https://example.com/v/1\n');
  });

  it('returns empty string when conferenceData has no video entry point', () => {
    const out = formatConferenceCompact({
      conferenceData: {
        conferenceSolution: { name: 'Phone' },
        entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-555-0100' }],
      },
    } as any);
    assert.equal(out, '');
  });

  it('returns empty string when entryPoints is empty or missing', () => {
    assert.equal(formatConferenceCompact({ conferenceData: {} } as any), '');
    assert.equal(formatConferenceCompact({ conferenceData: { entryPoints: [] } } as any), '');
  });
});

describe('formatConferenceDetail', () => {
  it('returns empty string when event has no conferencing', () => {
    assert.equal(formatConferenceDetail({ summary: 'plain' } as any), '');
  });

  it('emits Hangout Link when hangoutLink is present', () => {
    const out = formatConferenceDetail({ hangoutLink: 'https://meet.google.com/x' } as any);
    assert.equal(out, '\n**Hangout Link:** https://meet.google.com/x\n');
  });

  it('emits the conference solution name', () => {
    const out = formatConferenceDetail({
      conferenceData: { conferenceSolution: { name: 'Google Meet' } },
    } as any);
    assert.equal(out, '**Conference:** Google Meet\n');
  });

  it('lists every entry point with its type and uri', () => {
    const out = formatConferenceDetail({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.google.com/x' },
          { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
        ],
      },
    } as any);
    assert.match(out, /\*\*Conference Entry Points:\*\*/);
    assert.match(out, /- video https:\/\/meet\.google\.com\/x/);
    assert.match(out, /- phone tel:\+1-555-0100/);
  });

  it('appends the label in parens when an entry point has one', () => {
    const out = formatConferenceDetail({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1-555-0100', label: '+1 555-0100' },
        ],
      },
    } as any);
    assert.match(out, /- phone tel:\+1-555-0100 \(\+1 555-0100\)/);
  });

  it('omits parts that are missing without crashing', () => {
    const out = formatConferenceDetail({
      conferenceData: {
        entryPoints: [{ entryPointType: 'more' }],
      },
    } as any);
    assert.match(out, /- more\n/);
  });

  it('combines hangoutLink, solution name, and entry points in a single block', () => {
    const out = formatConferenceDetail({
      hangoutLink: 'https://meet.google.com/abc',
      conferenceData: {
        conferenceSolution: { name: 'Google Meet' },
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }],
      },
    } as any);
    assert.match(out, /\*\*Hangout Link:\*\* https:\/\/meet\.google\.com\/abc/);
    assert.match(out, /\*\*Conference:\*\* Google Meet/);
    assert.match(out, /- video https:\/\/meet\.google\.com\/abc/);
  });
});

describe('buildMeetConferenceData', () => {
  it('emits a createRequest with a hangoutsMeet solution key', () => {
    const data = buildMeetConferenceData();
    assert.equal(data.createRequest?.conferenceSolutionKey?.type, 'hangoutsMeet');
  });

  it('emits a non-empty requestId string', () => {
    const data = buildMeetConferenceData();
    assert.equal(typeof data.createRequest?.requestId, 'string');
    assert.ok((data.createRequest?.requestId?.length ?? 0) > 0);
  });

  it('generates a fresh requestId on every call', () => {
    // Google Calendar deduplicates conference creation by requestId — a stable id
    // across calls would silently return the same conference instead of a new one.
    const a = buildMeetConferenceData();
    const b = buildMeetConferenceData();
    assert.notEqual(a.createRequest?.requestId, b.createRequest?.requestId);
  });
});

describe('hasExistingConference', () => {
  it('returns false for a plain event with no conferencing', () => {
    assert.equal(hasExistingConference({ summary: 'plain' } as any), false);
  });

  it('returns true when hangoutLink is set', () => {
    assert.equal(hasExistingConference({ hangoutLink: 'https://meet.google.com/x' } as any), true);
  });

  it('returns true when conferenceData.conferenceId is set (provisioned)', () => {
    assert.equal(hasExistingConference({ conferenceData: { conferenceId: 'abc-defg-hij' } } as any), true);
  });

  it('returns true when a createRequest is in flight (no conferenceId yet)', () => {
    // Guards against firing a duplicate Meet request while Google is still
    // provisioning the previous one.
    assert.equal(hasExistingConference({
      conferenceData: {
        createRequest: {
          requestId: 'r-1',
          conferenceSolutionKey: { type: 'hangoutsMeet' },
          status: { statusCode: 'pending' },
        },
      },
    } as any), true);
  });

  it('returns false when conferenceData is present but empty', () => {
    assert.equal(hasExistingConference({ conferenceData: {} } as any), false);
  });
});

describe('formatMeetPendingHint', () => {
  it('returns empty when no Meet was requested', () => {
    assert.equal(formatMeetPendingHint(false, { conferenceData: { createRequest: { status: { statusCode: 'pending' } } } } as any), '');
  });

  it('returns empty when the Meet resolved synchronously (hangoutLink present)', () => {
    assert.equal(formatMeetPendingHint(true, { hangoutLink: 'https://meet.google.com/x' } as any), '');
  });

  it('returns empty when there is no createRequest status', () => {
    assert.equal(formatMeetPendingHint(true, { conferenceData: {} } as any), '');
  });

  it('returns empty when createRequest.status is success', () => {
    assert.equal(
      formatMeetPendingHint(true, { conferenceData: { createRequest: { status: { statusCode: 'success' } } } } as any),
      '',
    );
  });

  it('returns the "provisioning" hint when a fresh Meet request is still pending', () => {
    const out = formatMeetPendingHint(true, {
      conferenceData: { createRequest: { status: { statusCode: 'pending' } } },
    } as any);
    assert.match(out, /Meet Status/);
    assert.match(out, /provisioned \(pending\)/);
    assert.match(out, /getEvent/);
  });
});
