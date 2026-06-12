import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatConferenceCompact, formatConferenceDetail } from '../google-calendar/conferenceFormatter.js';

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
