// src/google-gmail/restRoutes.ts
// The Gmail REST writes as data: one descriptor per endpoint, which webServer.ts
// registers from a loop. Same shape and reasons as src/github/restRoutes.ts. Every
// request is validated with the MCP tool's own schema and goes through the same
// perform* function the tool calls, so the two surfaces cannot build a message
// differently.
//
// sendEmail and draftEmail were served long before they were catalogued, as
// ChatGPT Custom Actions compat, so their paths, 200 status and response keys
// stay exactly as they were. Array order is registration order, and
// /labels/get-or-create has to stay ahead of /labels/:labelId.

import type { gmail_v1 } from 'googleapis';
import type { ZodTypeAny } from 'zod';

import * as schemas from './schemas.js';
import {
  isSystemLabel, labelChanges, performBatchModifyEmails, performBatchTrashEmails, performCreateLabel,
  performDraftEmail, performGetOrCreateLabel, performModifyEmail, performSendEmail, performUpdateLabel,
} from './toolHandlers.js';

/** The parts of an Express request a descriptor reads. */
export interface GmailRestRequest {
  params: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface GmailWriteResult {
  status: number;
  body: unknown;
}

export interface GmailWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: GmailRestRequest) => Record<string, unknown>;
  run: (gmail: gmail_v1.Gmail, args: any) => Promise<GmailWriteResult>;
  notFound?: string;
  fallback: string;
}

const param = (req: GmailRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

const noLabels = (args: { addLabelIds?: string[]; removeLabelIds?: string[] }): boolean =>
  !args.addLabelIds?.length && !args.removeLabelIds?.length;

/** An empty change is a silent 200 over curl; the tool's caller gets it narrated. */
const refuse = (error: string): GmailWriteResult => ({ status: 400, body: { error } });

const NAME_A_LABEL = 'Name at least one label in addLabelIds or removeLabelIds.';
const NO_MESSAGES = 'messageIds is empty.';

/** Gmail's own status when a route should repeat it, for what sendUpstreamError turns into a 500. */
export function gmailPassthroughStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const status = [e?.code, e?.response?.status, e?.status].find((v) => typeof v === 'number') as number | undefined;
  return status === 400 || status === 409 || status === 429 ? status : undefined;
}

export const GMAIL_WRITE_ROUTES: ReadonlyArray<GmailWriteRoute> = [
  // ---- Messages ----
  {
    path: '/api/v1/gmail/messages/send', tool: 'sendEmail', schema: schemas.sendEmailSchema,
    params: () => ({}),
    run: async (gmail, args) => {
      const sent = await performSendEmail(gmail, args);
      return { status: 200, body: { id: sent.id, threadId: sent.threadId } };
    },
    fallback: 'Failed to send email',
  },
  {
    path: '/api/v1/gmail/drafts', tool: 'draftEmail', schema: schemas.draftEmailSchema,
    params: () => ({}),
    run: async (gmail, args) => {
      const draft = await performDraftEmail(gmail, args);
      return { status: 200, body: { id: draft.id, messageId: draft.message?.id } };
    },
    fallback: 'Failed to create draft',
  },
  {
    path: '/api/v1/gmail/messages/batch-modify', tool: 'batchModifyEmails', schema: schemas.batchModifyEmailsSchema,
    params: () => ({}),
    run: async (gmail, args) => {
      if (args.messageIds.length === 0) return refuse(NO_MESSAGES);
      if (noLabels(args)) return refuse(NAME_A_LABEL);
      await performBatchModifyEmails(gmail, args);
      return { status: 200, body: { requested: args.messageIds.length, confirmed: null } };
    },
    fallback: 'Failed to modify emails',
  },
  {
    path: '/api/v1/gmail/messages/batch-trash', tool: 'batchDeleteEmails', schema: schemas.batchDeleteEmailsSchema,
    params: () => ({}),
    run: async (gmail, args) => {
      if (args.messageIds.length === 0) return refuse(NO_MESSAGES);
      const { trashed, failed, notAttempted } = await performBatchTrashEmails(gmail, args.messageIds);
      // Nothing went, so this is an ordinary failure with an ordinary status.
      if (trashed.length === 0 && failed.length > 0) throw failed[0].error;
      return {
        status: 200,
        body: {
          requested: args.messageIds.length,
          trashed,
          failed: failed.map(({ id, error }) => ({ id, error: error?.message || 'Failed to trash email' })),
          notAttempted,
        },
      };
    },
    fallback: 'Failed to trash emails',
  },
  {
    path: '/api/v1/gmail/messages/:messageId/modify', tool: 'modifyEmail', schema: schemas.modifyEmailSchema,
    params: (req) => ({ messageId: param(req, 'messageId') }),
    run: async (gmail, args) => {
      if (noLabels(args)) return refuse(NAME_A_LABEL);
      const message = await performModifyEmail(gmail, args);
      return { status: 200, body: { id: message.id, labelIds: message.labelIds } };
    },
    notFound: 'Email not found', fallback: 'Failed to modify email',
  },
  {
    path: '/api/v1/gmail/messages/:messageId/trash', tool: 'deleteEmail', schema: schemas.deleteEmailSchema,
    params: (req) => ({ messageId: param(req, 'messageId') }),
    run: async (gmail, args) => {
      await gmail.users.messages.trash({ userId: 'me', id: args.messageId });
      return { status: 200, body: { trashed: true, id: args.messageId } };
    },
    notFound: 'Email not found', fallback: 'Failed to trash email',
  },

  // ---- Labels ----
  {
    path: '/api/v1/gmail/labels/get-or-create', tool: 'getOrCreateLabel', schema: schemas.getOrCreateLabelSchema,
    params: () => ({}),
    run: async (gmail, args) => {
      const { label, created } = await performGetOrCreateLabel(gmail, args);
      return { status: created ? 201 : 200, body: { label, created } };
    },
    fallback: 'Failed to get or create label',
  },
  {
    path: '/api/v1/gmail/labels', tool: 'createLabel', schema: schemas.createLabelSchema,
    params: () => ({}),
    run: async (gmail, args) => ({ status: 201, body: await performCreateLabel(gmail, args) }),
    fallback: 'Failed to create label',
  },
  {
    path: '/api/v1/gmail/labels/:labelId', tool: 'updateLabel', schema: schemas.updateLabelSchema,
    params: (req) => ({ labelId: param(req, 'labelId') }),
    run: async (gmail, args) => {
      if (Object.keys(labelChanges(args)).length === 0) return refuse('Nothing to update — pass at least one field to change.');
      return { status: 200, body: await performUpdateLabel(gmail, args) };
    },
    notFound: 'Label not found', fallback: 'Failed to update label',
  },
  {
    path: '/api/v1/gmail/labels/:labelId/delete', tool: 'deleteLabel', schema: schemas.deleteLabelSchema,
    params: (req) => ({ labelId: param(req, 'labelId') }),
    run: async (gmail, args) => {
      if (isSystemLabel(args.labelId)) return refuse(`Cannot delete system label: ${args.labelId}`);
      await gmail.users.labels.delete({ userId: 'me', id: args.labelId });
      return { status: 200, body: { deleted: true, labelId: args.labelId } };
    },
    notFound: 'Label not found', fallback: 'Failed to delete label',
  },
];

/** The body merged with the path params; a URL and a mismatched body key cannot disagree. */
export function writeArgs(route: GmailWriteRoute, req: GmailRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
