// src/pinecone/schemas.ts
// Zod parameter schemas for every Pinecone tool. Kept out of server.ts so
// ops.ts can type its args from them without an import cycle, and so a future
// REST route can validate against the same definitions the MCP tools do — the
// only thing that stops the two surfaces drifting.
//
// Tool names and parameter shapes deliberately match Pinecone's own MCP server
// (pinecone-io/pinecone-mcp), so a model that has seen one works with the
// other. Two things are deliberately NOT ported: its `llm_provider` /
// `llm_model` parameters, which exist to attribute usage to a model vendor and
// would be prompt noise on every tool here, and its reliance on the Pinecone
// SDK, which is why the camelCase-to-snake_case translation lives in
// apiHelpers.ts instead.

import { z } from 'zod';

import { PINECONE_UPSERT_MAX_RECORDS } from './indexKind.js';

/** Every tool that names an index takes it the same way. */
const indexNameField = z
  .string()
  .min(1)
  .describe('The index name. Run list-indexes first if you do not know it.');

/**
 * The namespace parameter.
 *
 * Required rather than defaulted, and the description NAMES the default
 * namespace, because a model that guesses "default" writes to a namespace
 * nobody reads. The name is `__default__`: Pinecone reserves it, refuses the
 * empty string this connector once documented, and reports it in index stats.
 */
const namespaceField = z
  .string()
  .describe(
    'The namespace to use. For the DEFAULT namespace pass "__default__" — that is Pinecone\'s reserved name for it, and what describe-index-stats reports. An empty string "" is also accepted and treated as __default__, but Pinecone itself rejects it. describe-index-stats lists the namespaces an index actually has.',
  );

export const RERANK_MODELS = ['cohere-rerank-3.5', 'bge-reranker-v2-m3', 'pinecone-rerank-v0'] as const;

const rerankModelField = z.enum(RERANK_MODELS).describe(`Choose a reranking model:
- "cohere-rerank-3.5" is Cohere's leading reranking model, balancing performance and latency for a wide range of enterprise search applications.
- "bge-reranker-v2-m3" is a high-performance, multilingual reranking model that works well on messy data and short queries expected to return medium-length passages of text (1-2 paragraphs).
- "pinecone-rerank-v0" is a state of the art reranking model that out-performs competitors on widely accepted benchmarks. It can handle chunks up to 512 tokens (1-2 paragraphs).`);

const searchQuerySchema = z
  .object({
    topK: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .describe(
        'The number of results to return. 10 is a reasonable default; use a larger value (e.g. 50) when reranking, so the reranker has more candidates to choose from. Very large values increase latency and response size.',
      ),
    inputs: z.object({
      text: z.string().min(1).describe('The text to search for.'),
    }),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'A filter to narrow the results, using the syntax of MongoDB query operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $and, $or. The records must actually carry the fields you filter on — run a search without a filter first and look at the "fields" of the hits. Filtering on a field the records do not have returns nothing.',
      ),
  })
  .describe('A query to search for records.');

/**
 * Rerank options shared by search-records (optional) and cascading-search
 * (required). Declared once so the two cannot describe the same parameter
 * differently.
 */
const rerankOptionsSchema = z.object({
  model: rerankModelField,
  topN: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The number of results to return after reranking. Must be less than or equal to query.topK.'),
  rankFields: z
    .array(z.string())
    .min(1)
    .describe(
      'The fields to rerank on. Include the field named by the index\'s embed.field_map (describe-index shows it). Every returned record must carry each listed field or Pinecone rejects the request. "bge-reranker-v2-m3" and "pinecone-rerank-v0" support only one field; "cohere-rerank-3.5" supports several.',
    ),
  query: z
    .string()
    .optional()
    .describe('An optional separate query to rerank against. Defaults to the search query text.'),
});

export const listIndexesSchema = z.object({});

export const describeIndexSchema = z.object({
  name: indexNameField,
});

export const describeIndexStatsSchema = z.object({
  name: indexNameField,
});

export const searchRecordsSchema = z.object({
  name: indexNameField,
  namespace: namespaceField,
  query: searchQuerySchema,
  rerank: rerankOptionsSchema
    .optional()
    .describe(
      'Optional reranking of the initial results. Use a query.topK larger than you need, then rerank down to topN — that is what makes reranking worth the extra call.',
    ),
});

export const cascadingSearchSchema = z.object({
  indexes: z
    .array(
      z.object({
        name: indexNameField,
        namespace: namespaceField,
      }),
    )
    .min(1)
    .describe('The indexes to search across. Records in each should share a common schema so one ranking makes sense.'),
  query: searchQuerySchema,
  rerank: rerankOptionsSchema.describe(
    'How to rerank the combined results. Required for this tool — the whole point is one fused ranking across the indexes.',
  ),
});

/**
 * A rerank document: a plain string, or a record whose values are strings.
 *
 * Typed as a union rather than z.any(). `z.any()` renders as the empty JSON
 * Schema `{}`, which gives a client nothing to keep an array as an array — the
 * failure already recorded for ClickUp's setCustomFieldValue, where the array
 * arrived as its own JSON text.
 */
const rerankDocumentSchema = z.union([z.string(), z.record(z.string(), z.string())]);

export const rerankDocumentsSchema = z.object({
  model: rerankModelField,
  query: z.string().min(1).describe('The query to rerank the documents against.'),
  documents: z
    .array(rerankDocumentSchema)
    .min(1)
    .describe(
      'The documents to rerank: either plain strings, or records whose values are all strings. Use this for documents that did NOT come from a Pinecone search; to rerank a single index\'s own results, use the rerank parameter of search-records instead.',
    ),
  options: z
    .object({
      topN: z.number().int().min(1).optional().describe('How many results to return after reranking.'),
      rankFields: z
        .array(z.string())
        .optional()
        .describe(
          'Which fields to rank on. Only meaningful when the documents are records. "bge-reranker-v2-m3" and "pinecone-rerank-v0" support one field; "cohere-rerank-3.5" supports several.',
        ),
    })
    .optional()
    .describe('Optional reranking controls. Omit to return every document, ranked.'),
});

export const searchDocsSchema = z.object({
  query: z.string().min(1).describe('What to look up in the Pinecone documentation.'),
});

export const createIndexForModelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(45)
    .describe('A unique name for the new index. Lowercase letters, digits and hyphens.'),
  cloud: z.enum(['aws', 'gcp', 'azure']).default('aws').describe('The cloud provider for the index. Defaults to aws.'),
  region: z
    .string()
    .default('us-east-1')
    .describe(
      'The region for the index. Common regions: aws (us-east-1, us-west-2, eu-west-1), gcp (us-central1, europe-west1), azure (eastus, westeurope). Defaults to us-east-1.',
    ),
  embed: z
    .object({
      model: z
        .enum(['multilingual-e5-large', 'llama-text-embed-v2', 'pinecone-sparse-english-v0'])
        .describe(`Choose an embedding model:
- "multilingual-e5-large" is an efficient dense embedding model trained on a mixture of multilingual datasets. It works well on messy data and short queries expected to return medium-length passages of text (1-2 paragraphs).
- "llama-text-embed-v2" is a high-performance dense embedding model optimized for text retrieval and ranking. It performs well on longer passages and structured documents.
- "pinecone-sparse-english-v0" is a sparse embedding model for keyword or hybrid search, estimating the lexical importance of tokens from their context.`),
      fieldMap: z
        .object({
          text: z
            .string()
            .min(1)
            .describe(
              'The name of the field in your records holding the text to embed. Every record you upsert must carry this field — pick the name you will actually use, because it cannot be changed later.',
            ),
        })
        .describe('Which field of your records gets embedded.'),
    })
    .describe('The embedding model that turns your text into vectors.'),
});

/**
 * One record to upsert.
 *
 * Loose rather than strict: the field_map text field is required and
 * everything else is stored as metadata, so the useful keys are not knowable
 * from here. The id and text-field checks happen in indexKind.ts against the
 * index's own schema, where the field NAME is known — a Zod rule could only
 * guess it.
 */
const upsertRecordSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'A record to upsert. Must have an "_id" field and the text field named by the index\'s embed.field_map (describe-index shows it). All other fields are stored as metadata.',
  );

export const upsertRecordsSchema = z.object({
  name: indexNameField,
  namespace: namespaceField,
  records: z
    .array(upsertRecordSchema)
    .min(1)
    .max(
      PINECONE_UPSERT_MAX_RECORDS,
      `Pinecone accepts at most ${PINECONE_UPSERT_MAX_RECORDS} records per upsert request. Send more than that in several calls — this is refused rather than split automatically because an upsert is not atomic across the body, so a failure part-way through several chunks would leave some records written and some not, with no way to roll back.`,
    )
    .describe(
      `The records to upsert, at most ${PINECONE_UPSERT_MAX_RECORDS} per call. Use a consistent shape for every record in an index. A record whose "_id" already exists is overwritten.`,
    ),
});
