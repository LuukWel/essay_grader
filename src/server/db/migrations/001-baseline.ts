// Migration 1: base schema.
//
// Also upgrades databases from before migrations (user_version 0): adds missing columns,
// removes the old A/B check on sessions.essay_set, and renames a low/high benchmarks table
// to benchmarks_legacy_low_high.

import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

function tableSql(db: Database.Database, name: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? null;
}

function addMissingColumns(db: Database.Database, table: string, columns: [name: string, definition: string][]) {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function upgradeLegacy(db: Database.Database) {
  if (tableSql(db, 'benchmarks')?.includes("'low', 'high'")) {
    db.exec('ALTER TABLE benchmarks RENAME TO benchmarks_legacy_low_high');
  }

  const sessionsSql = tableSql(db, 'sessions');
  if (sessionsSql?.includes("essay_set IN ('A', 'B')")) {
    // Earliest format: essay_set limited to A/B. Rebuild without that CHECK.
    db.exec(`
      CREATE TABLE sessions_widened (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL CHECK(condition IN ('baseline', 'dashboard')),
        essay_set TEXT NOT NULL,
        teacher_name TEXT,
        rubric_content TEXT NOT NULL,
        rubric_criteria_json TEXT,
        topic_method TEXT,
        processing_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      INSERT INTO sessions_widened
        SELECT id, participant_id, condition, essay_set, teacher_name, rubric_content,
               rubric_criteria_json, topic_method, processing_status, created_at, completed_at
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_widened RENAME TO sessions;
    `);
  }
  if (sessionsSql) {
    addMissingColumns(db, 'sessions', [
      ['use_precomputed_topics', 'INTEGER NOT NULL DEFAULT 0'],
      ['precomputed_k', 'INTEGER'],
      ['precompute_grades', 'INTEGER NOT NULL DEFAULT 1'],
      ['grades_precomputed', 'INTEGER NOT NULL DEFAULT 0'],
      ['use_cached_assessments', 'INTEGER NOT NULL DEFAULT 0'],
      ['assessment_type', "TEXT NOT NULL DEFAULT 'flow'"],
      ['assessment_length', "TEXT NOT NULL DEFAULT 'medium'"],
    ]);
  }

  if (tableSql(db, 'essays')) {
    addMissingColumns(db, 'essays', [
      ['essay_prompt', 'TEXT'],
      ['avg_ai_score', 'REAL'],
    ]);
  }
}

export const baseline: Migration = {
  version: 1,
  name: 'baseline',
  up(db) {
    upgradeLegacy(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL CHECK(condition IN ('baseline', 'dashboard')),
        essay_set TEXT NOT NULL,
        teacher_name TEXT,
        rubric_content TEXT NOT NULL,
        rubric_criteria_json TEXT,
        topic_method TEXT,
        use_precomputed_topics INTEGER NOT NULL DEFAULT 0,
        precomputed_k INTEGER,
        precompute_grades INTEGER NOT NULL DEFAULT 1,
        grades_precomputed INTEGER NOT NULL DEFAULT 0,
        use_cached_assessments INTEGER NOT NULL DEFAULT 0,
        assessment_type TEXT NOT NULL DEFAULT 'flow',
        assessment_length TEXT NOT NULL DEFAULT 'medium',
        processing_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS essays (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        filename TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        essay_prompt TEXT,
        pdf_content TEXT NOT NULL,
        summary TEXT,
        word_count INTEGER,
        topic_id INTEGER,
        topic_manually_reassigned INTEGER DEFAULT 0,
        is_flagged INTEGER DEFAULT 0,
        grading_status TEXT DEFAULT 'pending',
        overall_grade REAL,
        avg_ai_score REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        topic_index INTEGER NOT NULL,
        keywords TEXT NOT NULL,
        label TEXT
      );

      CREATE TABLE IF NOT EXISTS essay_similarities (
        session_id TEXT NOT NULL,
        essay_id_a TEXT NOT NULL,
        essay_id_b TEXT NOT NULL,
        similarity_score REAL NOT NULL,
        PRIMARY KEY (session_id, essay_id_a, essay_id_b)
      );

      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        criterion_name TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        teacher_score INTEGER,
        ai_score INTEGER,
        original_ai_score INTEGER,
        teacher_justification TEXT,
        ai_justification TEXT,
        evidence_json TEXT,
        graded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS benchmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        criterion_name TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        benchmark_type TEXT NOT NULL,
        score INTEGER NOT NULL,
        teacher_justification TEXT,
        ai_justification TEXT,
        set_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, criterion_name, benchmark_type)
      );

      CREATE TABLE IF NOT EXISTS action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL,
        essay_set TEXT NOT NULL,
        essay_id TEXT,
        action_type TEXT NOT NULL,
        action_detail TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS essay_summary_cache (
        tsv_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        embedding_json TEXT
      );

      CREATE TABLE IF NOT EXISTS topic_model_cache (
        essay_set TEXT NOT NULL,
        k INTEGER NOT NULL,
        embed_model TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        assignments_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (essay_set, k, embed_model, llm_model)
      );

      CREATE TABLE IF NOT EXISTS ai_assessment_cache (
        tsv_id TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        rubric_hash TEXT NOT NULL,
        assessment_type TEXT NOT NULL,
        assessment_length TEXT NOT NULL,
        ai_score INTEGER,
        ai_justification TEXT,
        evidence_json TEXT,
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tsv_id, criterion_id, rubric_hash, assessment_type, assessment_length)
      );

      CREATE TABLE IF NOT EXISTS teacher_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        criterion_name TEXT NOT NULL,
        start_index INTEGER NOT NULL,
        end_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  },
};
