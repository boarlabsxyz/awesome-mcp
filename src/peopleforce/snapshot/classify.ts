// src/peopleforce/snapshot/classify.ts
// Classify objectives as L&D activities with an LLM instead of regex. Dev sprints
// and courses live only as free-text objective titles ("Complete the Scrum course",
// "книга Донелла Медоуз", and typos like "Complete the curse"), which keyword
// matching can't handle reliably. Each objective is classified once and cached.
//
// Discipline that makes this auditable rather than a black box:
//  - Verdicts are keyed on (objective_id, text_hash, CLASSIFIER_VERSION). A
//    re-worded objective or a prompt/model bump re-classifies; nothing else does,
//    so a dashboard's historical counts don't shift under it. Bump the version
//    deliberately (in a migration), never incidentally.
//  - `completion` is derived from the objective's structured `progress`, NOT from
//    the prose — the reliable signal shouldn't inherit the fuzzy one's error.
//  - Low-confidence verdicts are flagged `needs_review` for a human queue.

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

import { ensureSnapshotTables } from './schema.js';
import type { SnapshotDb, SnapshotLog } from './collect.js';

/** Bump ONLY in a deliberate migration — changing it re-classifies every row. */
export const CLASSIFIER_VERSION = 1;

/** Confidence below this routes the verdict to the manual-review queue. */
const REVIEW_THRESHOLD = 0.6;

export const ACTIVITY_TYPES = [
  'course', 'book', 'sprint', 'workshop', 'mentorship', 'certification', 'conference', 'other',
] as const;

export const VerdictSchema = z.object({
  is_learning: z.boolean(),
  activity_type: z.enum(ACTIVITY_TYPES),
  provider: z.string().nullable(),
  confidence: z.number(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Raw JSON Schema sent to the API (structured outputs). Mirrors VerdictSchema. */
const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_learning: { type: 'boolean' },
    activity_type: { type: 'string', enum: [...ACTIVITY_TYPES] },
    provider: { type: ['string', 'null'] },
    confidence: { type: 'number' },
  },
  required: ['is_learning', 'activity_type', 'provider', 'confidence'],
  additionalProperties: false,
} as const;

/** A classifier maps objective text → verdict. Injectable so tests don't hit the API. */
export type Classifier = (input: { objectiveId: string; text: string }) => Promise<Verdict>;

export const CLASSIFIER_SYSTEM_PROMPT = [
  'You classify a single Learning & Development objective written by an employee.',
  'The text may be in any language and may contain typos — infer intent, do not keyword-match.',
  'Decide:',
  '- is_learning: true if this describes a learning/development activity (a course, book,',
  '  workshop, mentorship, certification, conference, or a "developmental sprint"), false if',
  '  it is ordinary project/delivery work.',
  '- activity_type: the best-fit category, or "other" when it is learning but none fit.',
  '- provider: the course/book/platform/vendor named, if any (e.g. "Coursera", "Anthropic',
  '  Academy", a book title); null if none is named.',
  '- confidence: 0.0–1.0, how sure you are of is_learning.',
  'Judge only from the text. Do not infer completion status — that is tracked separately.',
].join('\n');

export const PROMPT_HASH = crypto.createHash('sha256').update(CLASSIFIER_SYSTEM_PROMPT).digest('hex');

/** SHA-256 of the classified text — the cache key component that invalidates on edits. */
export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Derive completion from the objective's structured progress — reliable, unlike
 * the prose. 100 → completed, >0 → in_progress, else not_started; null when absent.
 */
export function deriveCompletion(progress: number | null | undefined): string | null {
  if (progress === null || progress === undefined) return null;
  if (progress >= 100) return 'completed';
  if (progress > 0) return 'in_progress';
  return 'not_started';
}

/** Build an Anthropic-backed classifier. Model defaults to Opus 4.8; override via env for cost. */
export function anthropicClassifier(opts: { client: Anthropic; model: string }): Classifier {
  return async ({ text }) => {
    const response = await opts.client.messages.create({
      model: opts.model,
      max_tokens: 1024,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: VERDICT_JSON_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = response.content.find((b) => b.type === 'text');
    const rawText = block && block.type === 'text' ? block.text : '';
    if (!rawText) throw new Error('classifier returned no structured output');
    return VerdictSchema.parse(JSON.parse(rawText));
  };
}

interface ObjectiveToClassify {
  objective_id: string;
  title: string;
  progress: number | null;
}

/**
 * Classify the latest-snapshot objectives that don't yet have a verdict for the
 * current (text_hash, version). Returns how many were newly classified vs skipped.
 */
export async function classifyObjectives(deps: {
  db: SnapshotDb;
  classifier: Classifier;
  modelId: string;
  classifiedAt: string;
  objectives?: ObjectiveToClassify[];
  log?: SnapshotLog;
}): Promise<{ classified: number; skipped: number; needsReview: number }> {
  const { db, classifier, modelId, classifiedAt } = deps;
  const log = deps.log ?? { info: () => {}, error: () => {} };
  await ensureSnapshotTables(db);

  // Latest title/progress per objective from the snapshot history.
  const objectives =
    deps.objectives ??
    (
      await db.query(
        `SELECT DISTINCT ON (objective_id) objective_id, title, progress
         FROM pf_objective_snapshot
         ORDER BY objective_id, captured_at DESC`,
      )
    ).rows.map((r) => ({ objective_id: String(r.objective_id), title: r.title ?? '', progress: r.progress ?? null }));

  let classified = 0;
  let skipped = 0;
  let needsReview = 0;

  for (const o of objectives) {
    const title = (o.title ?? '').trim();
    if (!title) { skipped++; continue; }
    const hash = textHash(title);

    const existing = await db.query(
      `SELECT 1 FROM pf_objective_classification
       WHERE objective_id = $1 AND text_hash = $2 AND classifier_version = $3`,
      [o.objective_id, hash, CLASSIFIER_VERSION],
    );
    if ((existing.rows ?? []).length > 0) { skipped++; continue; }

    let verdict: Verdict;
    try {
      verdict = await classifier({ objectiveId: o.objective_id, text: title });
    } catch (err: any) {
      log.error(`classify objective ${o.objective_id}: ${err?.message ?? err}`);
      continue;
    }

    const needs = verdict.confidence < REVIEW_THRESHOLD;
    if (needs) needsReview++;

    await db.query(
      `INSERT INTO pf_objective_classification
         (objective_id, text_hash, classifier_version, model_id, prompt_hash,
          is_learning, activity_type, provider, completion, confidence, needs_review, classified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (objective_id, text_hash, classifier_version) DO UPDATE SET
         model_id = EXCLUDED.model_id, prompt_hash = EXCLUDED.prompt_hash,
         is_learning = EXCLUDED.is_learning, activity_type = EXCLUDED.activity_type,
         provider = EXCLUDED.provider, completion = EXCLUDED.completion,
         confidence = EXCLUDED.confidence, needs_review = EXCLUDED.needs_review,
         classified_at = EXCLUDED.classified_at`,
      [
        o.objective_id, hash, CLASSIFIER_VERSION, modelId, PROMPT_HASH,
        verdict.is_learning, verdict.activity_type, verdict.provider,
        deriveCompletion(o.progress), verdict.confidence, needs, classifiedAt,
      ],
    );
    classified++;
  }

  log.info(`classified ${classified}, skipped ${skipped} (cached), needs_review ${needsReview}`);
  return { classified, skipped, needsReview };
}

/** CLI entrypoint — classify the latest snapshot's objectives. Run after the collector. */
async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey) { console.error('[pf-classify] ANTHROPIC_API_KEY is required'); process.exit(1); }
  if (!databaseUrl) { console.error('[pf-classify] DATABASE_URL is required'); process.exit(1); }

  const modelId = process.env.PEOPLEFORCE_CLASSIFIER_MODEL || 'claude-opus-4-8';
  const log: SnapshotLog = {
    info: (m) => console.error(`[pf-classify] ${m}`),
    error: (m) => console.error(`[pf-classify] ERROR ${m}`),
  };
  const client = new Anthropic({ apiKey });
  const classifier = anthropicClassifier({ client, model: modelId });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const conn = await pool.connect();
  const classifiedAt = new Date().toISOString();

  try {
    const res = await classifyObjectives({ db: conn, classifier, modelId, classifiedAt, log });
    log.info(`done: ${JSON.stringify(res)} (version ${CLASSIFIER_VERSION}, model ${modelId})`);
  } catch (err: any) {
    log.error(err?.message ?? String(err));
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
