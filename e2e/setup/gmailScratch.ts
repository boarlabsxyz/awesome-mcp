// Setup/teardown for the Gmail write smoke.
//
// Gmail has no folder to scope cleanup to, so scratch state is scoped two ways:
// every draft/message carries the `[e2e]` subject prefix, and everything the
// harness touches is filed under a dedicated label (E2E_GMAIL_SCRATCH_LABEL).
// cleanupScratchMail() is the safety net mirroring cleanupScratchFolder() —
// it permanently deletes every draft whose subject carries the prefix.
//
// The write smoke drives `draftEmail` rather than `sendEmail` on purpose: a
// draft is fully reversible, so a missed teardown leaves litter in the write
// account instead of mail in someone's inbox.

import { getWriteAccountClients } from './googleClient.ts';
import { SCRATCH_PREFIX, scratchName, isScratchName } from './scratchNaming.ts';

const SCRATCH_LABEL_ENV = 'E2E_GMAIL_SCRATCH_LABEL';

/** Label name (not id) that scratch mail is filed under. Defaults to `e2e-scratch`. */
export function scratchLabelName(): string {
  return process.env[SCRATCH_LABEL_ENV] || 'e2e-scratch';
}

/** Address the write smoke drafts to. Defaults to the authenticated account. */
export async function scratchRecipient(): Promise<string> {
  const explicit = process.env.E2E_GMAIL_SCRATCH_RECIPIENT;
  if (explicit) return explicit;

  const { gmail } = getWriteAccountClients();
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const address = profile.data.emailAddress;
  if (!address) throw new Error('gmail.users.getProfile returned no emailAddress');
  return address;
}

export function scratchSubject(label: string): string {
  return scratchName(label);
}

/** Resolve (creating if absent) the scratch label's id. */
export async function ensureScratchLabelId(): Promise<string> {
  const { gmail } = getWriteAccountClients();
  const name = scratchLabelName();

  const existing = await gmail.users.labels.list({ userId: 'me' });
  const found = (existing.data.labels ?? []).find((l) => l.name === name);
  if (found?.id) return found.id;

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  const id = created.data.id;
  if (!id) throw new Error(`gmail.users.labels.create returned no id for ${name}`);
  return id;
}

/** Ids of drafts whose subject contains `needle`. Used to verify + tear down. */
export async function findScratchDraftIds(needle: string): Promise<string[]> {
  const { gmail } = getWriteAccountClients();
  const res = await gmail.users.drafts.list({
    userId: 'me',
    q: `subject:${JSON.stringify(needle)}`,
    maxResults: 50,
  });
  return (res.data.drafts ?? []).map((d) => d.id).filter((id): id is string => Boolean(id));
}

export async function deleteDraft(draftId: string): Promise<void> {
  const { gmail } = getWriteAccountClients();
  await gmail.users.drafts.delete({ userId: 'me', id: draftId });
}

/**
 * Safety net — permanently delete every draft carrying the `[e2e]` subject
 * prefix. Drafts are cheap to enumerate (the write account holds no real mail),
 * so we page through and filter on the decoded subject header rather than
 * trusting Gmail's fuzzy `subject:` matching for the destructive sweep.
 */
export async function cleanupScratchMail(): Promise<void> {
  const { gmail } = getWriteAccountClients();

  let pageToken: string | undefined;
  do {
    const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
    for (const draft of res.data.drafts ?? []) {
      if (!draft.id) continue;
      const full = await gmail.users.drafts.get({
        userId: 'me',
        id: draft.id,
        format: 'metadata',
      });
      const subject = full.data.message?.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === 'subject',
      )?.value;
      if (isScratchName(subject)) await deleteDraft(draft.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

export { SCRATCH_PREFIX };
