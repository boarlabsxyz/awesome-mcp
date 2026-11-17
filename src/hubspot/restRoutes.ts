// src/hubspot/restRoutes.ts
// The HubSpot updates, property writes and engagement delete as data: one
// descriptor per endpoint, which webServer.ts registers from a loop, so the
// validation, status and error contract live in one handler.
//
// Unlike the GitHub and Redmine tables, this one imports its provider module by
// type only. Schemas and ops live in server.ts, which constructs an MCP server
// when imported, so webServer.ts imports it per request and hands it in here.

import type { HubSpotClient } from './apiHelpers.js';

type HubSpot = typeof import('./server.js');
type BodySchema = { safeParse(v: unknown): { success: boolean; data?: any; error?: any } };

/** The parts of an Express request a descriptor reads. */
export interface HubSpotRestRequest {
  params: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface HubSpotWriteRoute {
  path: string;
  tool: string;
  schema: (m: HubSpot) => BodySchema;
  /** Path params, which override same-named body keys. */
  params: (req: HubSpotRestRequest) => Record<string, unknown>;
  run: (m: HubSpot, client: HubSpotClient, args: any) => Promise<{ status: number; body: unknown }>;
  notFound: string;
  fallback: string;
}

const param = (req: HubSpotRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

/** HubSpot's own status when a route should repeat it, for what sendUpstreamError turns into a 500. */
export function hubspotPassthroughStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 400 || status === 409 || status === 429 ? status : undefined;
}

export const HUBSPOT_WRITE_ROUTES: ReadonlyArray<HubSpotWriteRoute> = [
  {
    path: '/api/v1/hubspot/companies/:companyId', tool: 'updateCompany', schema: m => m.updateCompanySchema,
    params: req => ({ companyId: param(req, 'companyId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateCompany(c, a) }),
    notFound: 'Company not found', fallback: 'Failed to update company',
  },
  {
    path: '/api/v1/hubspot/contacts/:contactId', tool: 'updateContact', schema: m => m.updateContactSchema,
    params: req => ({ contactId: param(req, 'contactId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateContact(c, a) }),
    notFound: 'Contact not found', fallback: 'Failed to update contact',
  },
  {
    path: '/api/v1/hubspot/deals/:dealId', tool: 'updateDeal', schema: m => m.updateDealSchema,
    params: req => ({ dealId: param(req, 'dealId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateDeal(c, a) }),
    notFound: 'Deal not found', fallback: 'Failed to update deal',
  },
  {
    path: '/api/v1/hubspot/properties/:objectType', tool: 'createProperty', schema: m => m.createPropertySchema,
    params: req => ({ objectType: param(req, 'objectType') }),
    run: async (m, c, a) => ({ status: 201, body: await m.performCreateProperty(c, a) }),
    notFound: 'Property group not found', fallback: 'Failed to create property',
  },
  {
    path: '/api/v1/hubspot/properties/:objectType/:propertyName', tool: 'updateProperty', schema: m => m.updatePropertySchema,
    params: req => ({ objectType: param(req, 'objectType'), propertyName: param(req, 'propertyName') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateProperty(c, a) }),
    notFound: 'Property not found', fallback: 'Failed to update property',
  },
  {
    path: '/api/v1/hubspot/engagements/:engagementType/:engagementId/update', tool: 'updateEngagement', schema: m => m.updateEngagementSchema,
    params: req => ({ engagementType: param(req, 'engagementType'), engagementId: param(req, 'engagementId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateEngagement(c, a) }),
    notFound: 'Engagement not found', fallback: 'Failed to update engagement',
  },
  {
    path: '/api/v1/hubspot/tickets', tool: 'createTicket', schema: m => m.createTicketSchema,
    params: () => ({}),
    run: async (m, c, a) => ({ status: 201, body: await m.performCreateTicket(c, a) }),
    notFound: 'Pipeline or stage not found', fallback: 'Failed to create ticket',
  },
  {
    path: '/api/v1/hubspot/tickets/:ticketId/update', tool: 'updateTicket', schema: m => m.updateTicketSchema,
    params: req => ({ ticketId: param(req, 'ticketId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdateTicket(c, a) }),
    notFound: 'Ticket not found', fallback: 'Failed to update ticket',
  },
  {
    path: '/api/v1/hubspot/pipelines/:objectType', tool: 'createPipeline', schema: m => m.createPipelineSchema,
    params: req => ({ objectType: param(req, 'objectType') }),
    run: async (m, c, a) => ({ status: 201, body: await m.performCreatePipeline(c, a) }),
    notFound: 'Object type not found', fallback: 'Failed to create pipeline',
  },
  {
    path: '/api/v1/hubspot/pipelines/:objectType/:pipelineId/update', tool: 'updatePipeline', schema: m => m.updatePipelineSchema,
    params: req => ({ objectType: param(req, 'objectType'), pipelineId: param(req, 'pipelineId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdatePipeline(c, a) }),
    notFound: 'Pipeline not found', fallback: 'Failed to update pipeline',
  },
  {
    path: '/api/v1/hubspot/pipelines/:objectType/:pipelineId/stages', tool: 'createPipelineStage', schema: m => m.createPipelineStageSchema,
    params: req => ({ objectType: param(req, 'objectType'), pipelineId: param(req, 'pipelineId') }),
    run: async (m, c, a) => ({ status: 201, body: await m.performCreatePipelineStage(c, a) }),
    notFound: 'Pipeline not found', fallback: 'Failed to create pipeline stage',
  },
  {
    path: '/api/v1/hubspot/pipelines/:objectType/:pipelineId/stages/:stageId/update', tool: 'updatePipelineStage', schema: m => m.updatePipelineStageSchema,
    params: req => ({ objectType: param(req, 'objectType'), pipelineId: param(req, 'pipelineId'), stageId: param(req, 'stageId') }),
    run: async (m, c, a) => ({ status: 200, body: await m.performUpdatePipelineStage(c, a) }),
    notFound: 'Stage not found', fallback: 'Failed to update pipeline stage',
  },
  {
    path: '/api/v1/hubspot/engagements/:engagementType/:engagementId/delete', tool: 'deleteEngagement', schema: m => m.deleteEngagementRestSchema,
    params: req => ({ engagementType: param(req, 'engagementType'), engagementId: param(req, 'engagementId') }),
    run: async (_m, c, a) => {
      await c.deleteEngagement(a.engagementType, a.engagementId);
      return { status: 200, body: { deleted: true, engagementType: a.engagementType, engagementId: a.engagementId } };
    },
    notFound: 'Engagement not found', fallback: 'Failed to delete engagement',
  },
];

/** The body merged with the path params; a URL and a mismatched body key cannot disagree. */
export function writeArgs(route: HubSpotWriteRoute, req: HubSpotRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
