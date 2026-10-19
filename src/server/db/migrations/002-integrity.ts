// Migration 2: foreign keys, unique keys, CHECKs and indexes.
//
// Essay and topic references include session_id, so a row can't point at an essay of
// another session. Scores are limited to 1-5.
//
// SQLite can't add constraints to an existing table, so each table is rebuilt (rename,
// create, copy, drop). A row that breaks a rule fails the copy and the whole migration.
// The cache tables are not touched.

import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

const SCORE = (column: string) => `CHECK (${column} IS NULL OR ${column} BETWEEN 1 AND 5)`;
const FLAG = (column: string) => `CHECK (${column} IN (0, 1))`;

interface Rebuild {
  table: string;
  create: string;
  /** Columns of the new table, and the matching expressions on the old (`old`) table. */
  columns: string[];
  select?: Record<string, string>;
}

const REBUILDS: Rebuild[] = [
  {
    table: 'sessions',
    create: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL CHECK (condition IN ('baseline', 'dashboard')),
        essay_set TEXT NOT NULL,
        teacher_name TEXT,
        rubric_content TEXT NOT NULL,
        rubric_criteria_json TEXT,
        topic_method TEXT,
        use_precomputed_topics INTEGER NOT NULL DEFAULT 0 ${FLAG('use_precomputed_topics')},
        precomputed_k INTEGER CHECK (precomputed_k IS NULL OR precomputed_k >= 2),
        precompute_grades INTEGER NOT NULL DEFAULT 1 ${FLAG('precompute_grades')},
        grades_precomputed INTEGER NOT NULL DEFAULT 0 ${FLAG('grades_precomputed')},
        use_cached_assessments INTEGER NOT NULL DEFAULT 0 ${FLAG('use_cached_assessments')},
        assessment_type TEXT NOT NULL DEFAULT 'flow' CHECK (assessment_type IN ('flow', 'bullets')),
        assessment_length TEXT NOT NULL DEFAULT 'medium' CHECK (assessment_length IN ('short', 'medium', 'long')),
        processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN
          ('pending', 'processing', 'summarising', 'topics', 'similarities', 'complete', 'error')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )`,
    columns: [
      'id', 'participant_id', 'condition', 'essay_set', 'teacher_name', 'rubric_content',
      'rubric_criteria_json', 'topic_method', 'use_precomputed_topics', 'precomputed_k',
      'precompute_grades', 'grades_precomputed', 'use_cached_assessments', 'assessment_type',
      'assessment_length', 'processing_status', 'created_at', 'completed_at',
    ],
    select: {
      processing_status: "COALESCE(processing_status, 'pending')",
      created_at: 'COALESCE(created_at, CURRENT_TIMESTAMP)',
    },
  },
  {
    table: 'topics',
    create: `
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        topic_index INTEGER NOT NULL CHECK (topic_index >= 0),
        keywords TEXT NOT NULL,
        label TEXT,
        UNIQUE (session_id, topic_index),
        UNIQUE (id, session_id)          -- target of the essays (topic_id, session_id) key
      )`,
    columns: ['id', 'session_id', 'topic_index', 'keywords', 'label'],
  },
  {
    table: 'essays',
    create: `
      CREATE TABLE essays (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        filename TEXT NOT NULL,          -- "essay-<dataset id>"
        pdf_path TEXT NOT NULL,
        essay_prompt TEXT,
        pdf_content TEXT NOT NULL,
        summary TEXT,
        word_count INTEGER CHECK (word_count IS NULL OR word_count >= 0),
        topic_id INTEGER,
        topic_manually_reassigned INTEGER NOT NULL DEFAULT 0 ${FLAG('topic_manually_reassigned')},
        is_flagged INTEGER NOT NULL DEFAULT 0 ${FLAG('is_flagged')},
        grading_status TEXT NOT NULL DEFAULT 'pending' CHECK (grading_status IN ('pending', 'grading', 'graded')),
        overall_grade REAL ${SCORE('overall_grade')},
        avg_ai_score REAL ${SCORE('avg_ai_score')},
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, filename),
        UNIQUE (id, session_id),         -- target of the (essay_id, session_id) keys below
        FOREIGN KEY (topic_id, session_id) REFERENCES topics(id, session_id)
      )`,
    columns: [
      'id', 'session_id', 'filename', 'pdf_path', 'essay_prompt', 'pdf_content', 'summary',
      'word_count', 'topic_id', 'topic_manually_reassigned', 'is_flagged', 'grading_status',
      'overall_grade', 'avg_ai_score', 'created_at',
    ],
    select: {
      topic_manually_reassigned: 'COALESCE(topic_manually_reassigned, 0)',
      is_flagged: 'COALESCE(is_flagged, 0)',
      grading_status: "COALESCE(grading_status, 'pending')",
      created_at: 'COALESCE(created_at, CURRENT_TIMESTAMP)',
    },
  },
  {
    table: 'grades',
    create: `
      CREATE TABLE grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        essay_id TEXT NOT NULL,
        criterion_name TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        teacher_score INTEGER ${SCORE('teacher_score')},
        ai_score INTEGER ${SCORE('ai_score')},
        original_ai_score INTEGER ${SCORE('original_ai_score')},
        teacher_justification TEXT,
        ai_justification TEXT,
        evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
        graded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, essay_id, criterion_name),
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: [
      'id', 'session_id', 'essay_id', 'criterion_name', 'criterion_id', 'teacher_score', 'ai_score',
      'original_ai_score', 'teacher_justification', 'ai_justification', 'evidence_json', 'graded_at',
    ],
  },
  {
    table: 'benchmarks',
    create: `
      CREATE TABLE benchmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        criterion_name TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        benchmark_type TEXT NOT NULL,    -- the score as text: one benchmark per score
        score INTEGER NOT NULL ${SCORE('score')},
        teacher_justification TEXT,
        ai_justification TEXT,
        set_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, criterion_name, benchmark_type),
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: [
      'id', 'session_id', 'criterion_name', 'essay_id', 'benchmark_type', 'score',
      'teacher_justification', 'ai_justification', 'set_at',
    ],
  },
  {
    table: 'teacher_highlights',
    create: `
      CREATE TABLE teacher_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        essay_id TEXT NOT NULL,
        criterion_name TEXT NOT NULL,
        start_index INTEGER NOT NULL CHECK (start_index >= 0),
        end_index INTEGER NOT NULL CHECK (end_index > start_index),
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: ['id', 'session_id', 'essay_id', 'criterion_name', 'start_index', 'end_index', 'text', 'created_at'],
  },
  {
    table: 'essay_similarities',
    create: `
      CREATE TABLE essay_similarities (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        essay_id_a TEXT NOT NULL,
        essay_id_b TEXT NOT NULL,
        similarity_score REAL NOT NULL CHECK (similarity_score BETWEEN -1 AND 1),
        PRIMARY KEY (session_id, essay_id_a, essay_id_b),
        CHECK (essay_id_a <> essay_id_b),
        FOREIGN KEY (essay_id_a, session_id) REFERENCES essays(id, session_id),
        FOREIGN KEY (essay_id_b, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: ['session_id', 'essay_id_a', 'essay_id_b', 'similarity_score'],
  },
  {
    table: 'action_logs',
    create: `
      CREATE TABLE action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL,
        essay_set TEXT NOT NULL,
        essay_id TEXT,                   -- not a foreign key: free-form context from the client
        action_type TEXT NOT NULL,
        action_detail TEXT,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    columns: [
      'id', 'session_id', 'participant_id', 'condition', 'essay_set', 'essay_id',
      'action_type', 'action_detail', 'timestamp',
    ],
    select: { timestamp: 'COALESCE(timestamp, CURRENT_TIMESTAMP)' },
  },
];

const INDEXES = `
  -- Export and timing: all events of a session in time order.
  CREATE INDEX idx_action_logs_session_time ON action_logs (session_id, timestamp);
  -- Rank history and precompute progress: one event type of a session.
  CREATE INDEX idx_action_logs_session_type ON action_logs (session_id, action_type, timestamp);
  -- Highlights of one essay, in text order.
  CREATE INDEX idx_highlights_session_essay ON teacher_highlights (session_id, essay_id, start_index);
`;

function rebuildAll(db: Database.Database) {
  for (const { table } of REBUILDS) db.exec(`ALTER TABLE ${table} RENAME TO old_${table}`);
  for (const { create } of REBUILDS) db.exec(create);

  for (const { table, columns, select = {} } of REBUILDS) {
    const exprs = columns.map((c) => select[c] ?? c).join(', ');
    try {
      db.exec(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${exprs} FROM old_${table}`);
    } catch (err) {
      throw new Error(`copying ${table}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const { table } of [...REBUILDS].reverse()) db.exec(`DROP TABLE old_${table}`);
  db.exec(INDEXES);
}

export const integrity: Migration = {
  version: 2,
  name: 'integrity',
  up: rebuildAll,
};
