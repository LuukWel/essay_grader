// Stored model results, shared across sessions. Rows are keyed by a hash of their inputs
// (src/lib/cache-key.ts) and keep those inputs as columns.

import { getDb } from './client';

// Summaries

export interface SummaryInputs {
  key: string;
  contentHash: string;
  model: string;
  promptVersion: number;
}

export function getSummary(key: string): string | null {
  const row = getDb().prepare('SELECT summary FROM essay_summaries WHERE cache_key = ?').get(key) as
    | { summary: string }
    | undefined;
  return row?.summary ?? null;
}

export function saveSummary(inputs: SummaryInputs, summary: string): void {
  getDb().prepare(`
    INSERT INTO essay_summaries (cache_key, content_hash, model, prompt_version, summary)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET summary = excluded.summary, created_at = CURRENT_TIMESTAMP
  `).run(inputs.key, inputs.contentHash, inputs.model, inputs.promptVersion, summary);
}

// Embeddings

export interface EmbeddingInputs {
  key: string;
  contentHash: string;
  model: string;
  inputVersion: string;
}

export function getEmbedding(key: string): number[] | null {
  const row = getDb().prepare('SELECT embedding_json FROM essay_embeddings WHERE cache_key = ?').get(key) as
    | { embedding_json: string }
    | undefined;
  return row ? (JSON.parse(row.embedding_json) as number[]) : null;
}

/** Vector lengths stored for a model and input version: normally one value, [] if none yet. */
export function getEmbeddingDimensions(model: string, inputVersion: string): number[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT dimensions FROM essay_embeddings WHERE model = ? AND input_version = ? ORDER BY dimensions
  `).all(model, inputVersion) as { dimensions: number }[];
  return rows.map((r) => r.dimensions);
}

export function saveEmbedding(inputs: EmbeddingInputs, embedding: number[]): void {
  getDb().prepare(`
    INSERT INTO essay_embeddings (cache_key, content_hash, model, input_version, dimensions, embedding_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET
      dimensions = excluded.dimensions,
      embedding_json = excluded.embedding_json,
      created_at = CURRENT_TIMESTAMP
  `).run(inputs.key, inputs.contentHash, inputs.model, inputs.inputVersion, embedding.length, JSON.stringify(embedding));
}

// AI assessments

export interface AssessmentInputs {
  key: string;
  contentHash: string;
  criterionId: number;
  criterionHash: string;
  model: string;
  promptVersion: number;
  assessmentType: string;
  assessmentLength: string;
}

export interface StoredAssessment {
  status: 'success' | 'failed';
  score: number | null;
  justification: string | null;
  evidence_json: string | null;
  error: string | null;
  attempts: number;
}

export function getAssessment(key: string): StoredAssessment | null {
  return (getDb().prepare(
    'SELECT status, score, justification, evidence_json, error, attempts FROM ai_assessments WHERE cache_key = ?'
  ).get(key) as StoredAssessment) ?? null;
}

const INSERT_ASSESSMENT = `
  INSERT INTO ai_assessments (
    cache_key, content_hash, criterion_id, criterion_hash, model, prompt_version,
    assessment_type, assessment_length, status, score, justification, evidence_json, error)
  VALUES (@key, @contentHash, @criterionId, @criterionHash, @model, @promptVersion,
    @assessmentType, @assessmentLength, @status, @score, @justification, @evidence, @error)
  ON CONFLICT (cache_key) DO UPDATE SET
    status = excluded.status,
    score = excluded.score,
    justification = excluded.justification,
    evidence_json = excluded.evidence_json,
    error = excluded.error,
    attempts = attempts + 1,
    updated_at = CURRENT_TIMESTAMP
`;

export function saveAssessmentSuccess(
  inputs: AssessmentInputs,
  result: { score: number; justification: string; evidenceJson: string | null },
): void {
  getDb().prepare(INSERT_ASSESSMENT).run({
    ...inputs, status: 'success', score: result.score, justification: result.justification,
    evidence: result.evidenceJson, error: null,
  });
}

/** Records a failed attempt. Failures are never reused; the next run retries. */
export function saveAssessmentFailure(inputs: AssessmentInputs, error: string): void {
  getDb().prepare(INSERT_ASSESSMENT).run({
    ...inputs, status: 'failed', score: null, justification: null, evidence: null, error,
  });
}

// Topic models

export interface TopicModelResult {
  topics: { label: string; keywords: string[] }[];
  /** tsv_id -> topic_index */
  assignments: Record<string, number>;
}

export interface TopicModelInputs {
  key: string;
  essaySet: string;
  inputHash: string;
  k: number;
  embedModel: string;
  llmModel: string;
  methodVersion: number;
}

export function getTopicModel(key: string): TopicModelResult | null {
  const row = getDb().prepare('SELECT topics_json, assignments_json FROM topic_models WHERE cache_key = ?').get(key) as
    | { topics_json: string; assignments_json: string }
    | undefined;
  if (!row) return null;
  return { topics: JSON.parse(row.topics_json), assignments: JSON.parse(row.assignments_json) };
}

export function saveTopicModel(inputs: TopicModelInputs, result: TopicModelResult, preprocessing: string | null): void {
  getDb().prepare(`
    INSERT INTO topic_models (cache_key, essay_set, input_hash, k, embed_model, llm_model, method_version,
                              preprocessing, topics_json, assignments_json)
    VALUES (@key, @essaySet, @inputHash, @k, @embedModel, @llmModel, @methodVersion,
            @preprocessing, @topics, @assignments)
    ON CONFLICT (cache_key) DO UPDATE SET
      preprocessing = excluded.preprocessing,
      topics_json = excluded.topics_json,
      assignments_json = excluded.assignments_json,
      created_at = CURRENT_TIMESTAMP
  `).run({
    ...inputs, preprocessing,
    topics: JSON.stringify(result.topics), assignments: JSON.stringify(result.assignments),
  });
}

/** k values with a stored topic model for exactly these essays, models and method. */
export function getCachedTopicKs(
  i: Pick<TopicModelInputs, 'essaySet' | 'inputHash' | 'embedModel' | 'llmModel' | 'methodVersion'>,
): number[] {
  const rows = getDb().prepare(`
    SELECT k FROM topic_models
    WHERE essay_set = ? AND input_hash = ? AND embed_model = ? AND llm_model = ? AND method_version = ?
    ORDER BY k
  `).all(i.essaySet, i.inputHash, i.embedModel, i.llmModel, i.methodVersion) as { k: number }[];
  return rows.map((r) => r.k);
}

/** Deletes stored topic models for one essay set, or all of them. Returns the number removed. */
export function clearTopicModelCache(essaySet?: string): number {
  const db = getDb();
  const result = essaySet
    ? db.prepare('DELETE FROM topic_models WHERE essay_set = ?').run(essaySet)
    : db.prepare('DELETE FROM topic_models').run();
  return result.changes;
}
