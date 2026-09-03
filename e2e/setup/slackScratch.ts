// Setup/teardown for Slack write tests (both the bot-token and user-token
// servers).
//
// Scoped to a dedicated scratch CHANNEL (E2E_SLACK_SCRATCH_CHANNEL_ID) in the
// test workspace — the Slack analogue of e2e-scratch/. Nothing outside that
// channel is ever read or deleted. Messages carry the `[e2e]` prefix so an
// orphan is recognizable in the channel if teardown misses, and so the cleanup
// sweep can tell harness traffic from anything a human typed there.
//
// Deletion caveat: Slack's chat.delete only removes messages authored by the
// calling token. The scratch client is therefore configured with the SAME
// identity as the connector under test (see setup/slackClient.ts). If they
// drift apart, `cant_delete_message` is surfaced as a warning rather than
// failing an otherwise-green test — the message is still findable by prefix.

import { getSlackWriteClient, type SlackService } from './slackClient.ts';
import { SCRATCH_PREFIX, scratchName, isScratchName, required } from './scratchNaming.ts';

const DOC = 'e2e/fixtures/write-slack.md';

export function scratchChannelId(): string {
  return required('E2E_SLACK_SCRATCH_CHANNEL_ID', DOC);
}

export interface ScratchMessage {
  ts: string;
  text: string;
}

/** Seed a message the read smoke can assert against, or a thread parent. */
export async function postScratchMessage(
  service: SlackService,
  label: string,
  body: string,
): Promise<ScratchMessage> {
  const text = `${scratchName(label)} :: ${body}`;
  const res = await getSlackWriteClient(service).call<{ ok: boolean; ts?: string }>(
    'chat.postMessage',
    { channel: scratchChannelId(), text },
  );
  if (!res.ts) throw new Error('Slack chat.postMessage returned no ts');
  return { ts: res.ts, text };
}

interface HistoryMessage {
  ts?: string;
  text?: string;
  subtype?: string;
}

export async function recentMessages(
  service: SlackService,
  limit = 50,
): Promise<HistoryMessage[]> {
  const res = await getSlackWriteClient(service).call<{
    ok: boolean;
    messages?: HistoryMessage[];
  }>('conversations.history', { channel: scratchChannelId(), limit });
  return res.messages ?? [];
}

export async function deleteScratchMessage(service: SlackService, ts: string): Promise<void> {
  try {
    await getSlackWriteClient(service).call('chat.delete', {
      channel: scratchChannelId(),
      ts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A message the MCP posted under a different identity can't be deleted by
    // this token. Leave it — it's prefixed, so it's identifiable — and say so.
    if (message.includes('cant_delete_message') || message.includes('message_not_found')) {
      console.error(`[e2e] could not delete scratch message ${ts}: ${message}`);
      return;
    }
    throw err;
  }
}

/**
 * Safety net mirroring cleanupScratchFolder() — delete every `[e2e]`-prefixed
 * message in the scratch channel. Bounded to the most recent 200 messages: the
 * scratch channel should hover near empty, and an unbounded sweep of a channel
 * someone repurposed is exactly the destructive accident this is meant to avoid.
 */
export async function cleanupScratchChannel(service: SlackService): Promise<void> {
  const messages = await recentMessages(service, 200);
  for (const message of messages) {
    // Slack prefixes bot/user text identically; the `[e2e]` marker is what
    // distinguishes harness traffic from anything else in the channel.
    if (message.ts && isScratchName(message.text)) {
      await deleteScratchMessage(service, message.ts);
    }
  }
}

export { SCRATCH_PREFIX };
