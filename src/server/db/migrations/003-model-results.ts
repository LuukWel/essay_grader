// Migration 3: model result tables keyed by a hash of their inputs (src/lib/cache-key.ts).
//
// The old cache tables are keyed by essay ID and don't record the model or prompt, so
// their rows can't be converted. Non-empty ones are kept as legacy_<name> (the app doesn't
// read them); empty ones are dropped.

import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

const OLD_CACHES = ['essay_summary_cache', 'ai_assessment_cache', 'topic_model_cache'];

function retireOldCache(db: Database.Database, table: string) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return;
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.exec(n > 0 ? `ALTER TABLE ${table} RENAME TO legacy_${table}` : `DROP TABLE ${table}`);
}

export const modelResults: Migration = {
  version: 3,
  name: 'model-results',
  up(db) {
    for (const table of OLD_CACHES) retireOldCache(db, table);

    db.exec(`
      CREATE TABLE essay_summaries (
        cache_key TEXT PRIMARY KEY,                -- summaryKey(content, model, prompt version)
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version INTEGER NOT NULL,
        summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE essay_embeddings (
        cache_key TEXT PRIMARY KEY,                -- embeddingKey(content, model, input version)
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        input_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        embedding_json TEXT NOT NULL
          CHECK (json_valid(embedding_json) AND json_array_length(embedding_json) = dimensions),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE ai_assessments (
        cache_key TEXT PRIMARY KEY,                -- assessmentKey(content, criterion, model, prompt, style)
        content_hash TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        criterion_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version INTEGER NOT NULL,
        assessment_type TEXT NOT NULL,
        assessment_length TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        score INTEGER CHECK (score IS NULL OR score BETWEEN 1 AND 5),
        justification TEXT,
        evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        -- A success always has a usable result; a failure always says why.
        CHECK (status = 'failed' OR (score IS NOT NULL AND justification IS NOT NULL)),
        CHECK (status = 'success' OR error IS NOT NULL)
      );

      CREATE TABLE topic_models (
        cache_key TEXT PRIMARY KEY,                -- topicModelKey(set, essays, k, models, method)
        essay_set TEXT NOT NULL,
        input_hash TEXT NOT NULL,                  -- the essay IDs and texts that were clustered
        k INTEGER NOT NULL CHECK (k >= 2),
        embed_model TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        method_version INTEGER NOT NULL,
        preprocessing TEXT,                        -- reported by the script: spacy-lemma | sklearn-stopwords
        topics_json TEXT NOT NULL CHECK (json_valid(topics_json)),
        assignments_json TEXT NOT NULL CHECK (json_valid(assignments_json)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Setup screen: which k values are already cached for the current essays and models.
      CREATE INDEX idx_topic_models_inputs ON topic_models (essay_set, input_hash, embed_model, llm_model, method_version);
    `);
  },
};
