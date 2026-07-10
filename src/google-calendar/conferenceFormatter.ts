// src/google-calendar/conferenceFormatter.ts
// Pure formatters for an Event's conferencing fields (hangoutLink / conferenceData).
// Extracted so the listEvents / getEvent tools can be unit-tested without FastMCP.
import { randomUUID } from 'node:crypto';
import type { calendar_v3 } from 'googleapis';

type Event = calendar_v3.Schema$Event;

/**
 * Build the conferenceData.createRequest payload that tells Google Calendar to
 * mint a fresh Google Meet conference for the event. The caller must also pass
 * conferenceDataVersion=1 on the events.insert / events.update request — without
 * that flag the API silently ignores conferenceData.
 */
export function buildMeetConferenceData(): calendar_v3.Schema$ConferenceData {
  return {
    createRequest: {
      requestId: randomUUID(),
      conferenceSolutionKey: { type: 'hangoutsMeet' },
    },
  };
}

/**
 * One-line conferencing summary for list-style output.
 * Returns '' when the event has no video conference attached.
 */
export function formatConferenceCompact(event: Event): string {
  if (event.hangoutLink) {
    return `   Meet: ${event.hangoutLink}\n`;
  }
  const video = event.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video');
  if (video?.uri) {
    const name = event.conferenceData?.conferenceSolution?.name || 'Conference';
    return `   ${name}: ${video.uri}\n`;
  }
  return '';
}

/**
 * Multi-line conferencing block for detail-style output.
 * Emits the Hangout Link, conference solution name, and every entry point
 * (video / phone / sip / more) so the caller can pick the right join method.
 * Returns '' when the event has no conferencing data.
 */
export function formatConferenceDetail(event: Event): string {
  let out = '';
  if (event.hangoutLink) {
    out += `\n**Hangout Link:** ${event.hangoutLink}\n`;
  }
  if (event.conferenceData) {
    const conf = event.conferenceData;
    if (conf.conferenceSolution?.name) {
      out += `**Conference:** ${conf.conferenceSolution.name}\n`;
    }
    if (conf.entryPoints?.length) {
      out += `**Conference Entry Points:**\n`;
      for (const ep of conf.entryPoints) {
        const parts = [ep.entryPointType, ep.uri].filter(Boolean);
        const line = parts.join(' ');
        out += ep.label ? `  - ${line} (${ep.label})\n` : `  - ${line}\n`;
      }
    }
  }
  return out;
}
