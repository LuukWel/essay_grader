// Migration 5: rubric tables, topic assignment history and the remaining foreign keys.
//
// - rubrics, rubric_criteria, rubric_levels. Grades, benchmarks and highlights reference
//   (rubric_id, criterion_id), and (session_id, rubric_id) references the session, so a
//   criterion has to belong to the session's rubric.
// - topic_assignments (append-only, source model or manual) and the view
//   essay_current_topics. Replaces essays.topic_id and essays.topic_manually_reassigned.
// - essay_similarities gets embedding_model and embedding_input_version.
// - action_logs.essay_id becomes a foreign key.
// - Drops unused columns: sessions.teacher_name, rubric_criteria_json, topic_method,
//   rubric_content (moved to rubrics.source_text) and benchmarks.benchmark_type (= score).
//
// All existing sessions used RUBRIC_V1; it is stored as 'essay-v1' with their rubric text.
// If the data doesn't fit (several rubric texts, unknown criteria, values in a dropped
// column) the migration throws and nothing changes.
//
// legacy_alter_table is on while renaming, so foreign keys in other tables keep pointing
// at the original table names.

import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

const SCORE = (column: string) => `CHECK (${column} IS NULL OR ${column} BETWEEN 1 AND 5)`;
const FLAG = (column: string) => `CHECK (${column} IN (0, 1))`;

/** The rubric all sessions used before rubrics were stored. Don't change it. */
const RUBRIC_V1 = {
  id: 'essay-v1',
  criteria: [
    {
      id: 1, name: 'Content', levels: [
        'No clear position or completely off-topic.',
        'A position is stated but reasons or examples are missing or irrelevant.',
        'Position is clear with some supporting reasons; examples may be limited or underdeveloped.',
        'Position is well-supported with relevant reasons and examples; argument is mostly consistent.',
        'Position is clearly argued throughout with strong, relevant reasons and specific examples.',
      ],
    },
    {
      id: 2, name: 'Organization', levels: [
        'No discernible structure; very hard to follow.',
        'Some attempt at structure but ideas are jumbled or transitions are absent.',
        'Basic structure is present; ideas are mostly in order but connections between paragraphs are weak.',
        'Clear structure with logical paragraph order and transitions that help the reader follow the argument.',
        'Well-organized throughout; each paragraph develops a single idea and connects clearly to the overall argument.',
      ],
    },
    {
      id: 3, name: 'Language', levels: [
        'Frequent grammatical errors that make the essay difficult to understand.',
        'Several errors that distract from meaning, though the message is recoverable.',
        'Meaning is generally clear; errors are present but do not seriously affect comprehension.',
        'Mostly accurate grammar and vocabulary; errors are minor and infrequent.',
        'Accurate grammar throughout with a varied vocabulary; writing is fluent and easy to read.',
      ],
    },
  ],
};

const RUBRIC_TABLES = `
  CREATE TABLE rubrics (
    id TEXT PRIMARY KEY,                       -- e.g. 'essay-v1'; a changed rubric gets a new id
    source_text TEXT NOT NULL CHECK (length(trim(source_text)) > 0),  -- the rubric as shown to teacher and model
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE rubric_criteria (
    rubric_id TEXT NOT NULL REFERENCES rubrics(id),
    criterion_id INTEGER NOT NULL CHECK (criterion_id >= 1),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    position INTEGER NOT NULL CHECK (position >= 1),  -- order on the grading screen
    min_score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    PRIMARY KEY (rubric_id, criterion_id),
    UNIQUE (rubric_id, name),
    UNIQUE (rubric_id, position),
    CHECK (1 <= min_score AND min_score < max_score AND max_score <= 5)
  );

  CREATE TABLE rubric_levels (
    rubric_id TEXT NOT NULL,
    criterion_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    PRIMARY KEY (rubric_id, criterion_id, score),
    FOREIGN KEY (rubric_id, criterion_id) REFERENCES rubric_criteria(rubric_id, criterion_id)
  );
`;

interface Rebuild {
  table: string;
  create: string;
  /** Columns of the new table, and the matching expressions on the old table (`old`). */
  columns: string[];
  select?: Record<string, string>;
}

/** criterion_id of rubric essay-v1 for the old row's criterion_name. */
const CRITERION_FROM_NAME = `(SELECT rc.criterion_id FROM rubric_criteria rc
  WHERE rc.rubric_id = 'essay-v1' AND rc.name = old.criterion_name)`;

const REBUILDS: Rebuild[] = [
  {
    table: 'sessions',
    create: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        condition TEXT NOT NULL CHECK (condition IN ('baseline', 'dashboard')),
        essay_set TEXT NOT NULL,           -- data/subset_<essay_set>.csv
        rubric_id TEXT NOT NULL REFERENCES rubrics(id),
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
        completed_at DATETIME,
        UNIQUE (id, rubric_id)             -- target of the (session_id, rubric_id) keys below
      )`,
    columns: [
      'id', 'participant_id', 'condition', 'essay_set', 'rubric_id', 'use_precomputed_topics',
      'precomputed_k', 'precompute_grades', 'grades_precomputed', 'use_cached_assessments',
      'assessment_type', 'assessment_length', 'processing_status', 'created_at', 'completed_at',
    ],
    select: { rubric_id: "'essay-v1'" },
  },
  {
    table: 'topics',
    create: `
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        topic_index INTEGER NOT NULL CHECK (topic_index >= 0),
        keywords TEXT NOT NULL,            -- JSON array
        label TEXT,
        UNIQUE (session_id, topic_index),
        UNIQUE (id, session_id)            -- target of the topic_assignments (topic_id, session_id) key
      )`,
    columns: ['id', 'session_id', 'topic_index', 'keywords', 'label'],
  },
  {
    table: 'essays',
    create: `
      CREATE TABLE essays (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        filename TEXT NOT NULL,            -- "essay-<dataset id>"
        pdf_path TEXT NOT NULL,            -- the CSV file the essay was imported from
        essay_prompt TEXT,
        pdf_content TEXT NOT NULL,         -- the essay text
        summary TEXT,
        word_count INTEGER CHECK (word_count IS NULL OR word_count >= 0),
        is_flagged INTEGER NOT NULL DEFAULT 0 ${FLAG('is_flagged')},
        grading_status TEXT NOT NULL DEFAULT 'pending' CHECK (grading_status IN ('pending', 'grading', 'graded')),
        overall_grade REAL ${SCORE('overall_grade')},
        avg_ai_score REAL ${SCORE('avg_ai_score')},
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, filename),
        UNIQUE (id, session_id)            -- target of the (essay_id, session_id) keys
      )`,
    columns: [
      'id', 'session_id', 'filename', 'pdf_path', 'essay_prompt', 'pdf_content', 'summary',
      'word_count', 'is_flagged', 'grading_status', 'overall_grade', 'avg_ai_score', 'created_at',
    ],
  },
  {
    table: 'grades',
    create: `
      CREATE TABLE grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        rubric_id TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        teacher_score INTEGER ${SCORE('teacher_score')},
        ai_score INTEGER ${SCORE('ai_score')},
        original_ai_score INTEGER ${SCORE('original_ai_score')},  -- first AI score, kept when it is revised
        teacher_justification TEXT,
        ai_justification TEXT,
        evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
        graded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, essay_id, criterion_id),
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id),
        FOREIGN KEY (session_id, rubric_id) REFERENCES sessions(id, rubric_id),
        FOREIGN KEY (rubric_id, criterion_id) REFERENCES rubric_criteria(rubric_id, criterion_id)
      )`,
    columns: [
      'id', 'session_id', 'essay_id', 'rubric_id', 'criterion_id', 'teacher_score', 'ai_score',
      'original_ai_score', 'teacher_justification', 'ai_justification', 'evidence_json', 'graded_at',
    ],
    select: { rubric_id: "'essay-v1'", criterion_id: CRITERION_FROM_NAME },
  },
  {
    table: 'benchmarks',
    create: `
      CREATE TABLE benchmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        rubric_id TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
        essay_id TEXT NOT NULL,
        teacher_justification TEXT,
        ai_justification TEXT,
        set_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, criterion_id, score),  -- one benchmark essay per criterion and score
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id),
        FOREIGN KEY (session_id, rubric_id) REFERENCES sessions(id, rubric_id),
        FOREIGN KEY (rubric_id, criterion_id) REFERENCES rubric_criteria(rubric_id, criterion_id)
      )`,
    columns: [
      'id', 'session_id', 'rubric_id', 'criterion_id', 'score', 'essay_id',
      'teacher_justification', 'ai_justification', 'set_at',
    ],
    select: { rubric_id: "'essay-v1'", criterion_id: CRITERION_FROM_NAME },
  },
  {
    table: 'teacher_highlights',
    create: `
      CREATE TABLE teacher_highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        essay_id TEXT NOT NULL,
        rubric_id TEXT NOT NULL,
        criterion_id INTEGER NOT NULL,
        start_index INTEGER NOT NULL CHECK (start_index >= 0),   -- text = essay[start_index, end_index)
        end_index INTEGER NOT NULL CHECK (end_index > start_index),
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id),
        FOREIGN KEY (session_id, rubric_id) REFERENCES sessions(id, rubric_id),
        FOREIGN KEY (rubric_id, criterion_id) REFERENCES rubric_criteria(rubric_id, criterion_id)
      )`,
    columns: [
      'id', 'session_id', 'essay_id', 'rubric_id', 'criterion_id', 'start_index', 'end_index', 'text', 'created_at',
    ],
    select: { rubric_id: "'essay-v1'", criterion_id: CRITERION_FROM_NAME },
  },
  {
    table: 'essay_similarities',
    create: `
      CREATE TABLE essay_similarities (
        session_id TEXT NOT NULL,
        essay_id_a TEXT NOT NULL,
        essay_id_b TEXT NOT NULL,          -- one of A's nearest neighbours
        similarity_score REAL NOT NULL CHECK (similarity_score BETWEEN -1 AND 1),  -- cosine
        -- The embeddings it was computed from (essay_embeddings.model, .input_version).
        -- NULL only on rows computed before this was recorded.
        embedding_model TEXT,
        embedding_input_version TEXT,
        PRIMARY KEY (session_id, essay_id_a, essay_id_b),
        CHECK (essay_id_a <> essay_id_b),
        CHECK ((embedding_model IS NULL) = (embedding_input_version IS NULL)),
        FOREIGN KEY (essay_id_a, session_id) REFERENCES essays(id, session_id),
        FOREIGN KEY (essay_id_b, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: ['session_id', 'essay_id_a', 'essay_id_b', 'similarity_score', 'embedding_model', 'embedding_input_version'],
    select: { embedding_model: 'NULL', embedding_input_version: 'NULL' },
  },
  {
    table: 'action_logs',
    create: `
      CREATE TABLE action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        participant_id TEXT NOT NULL,      -- copied from the session, so exports need no join
        condition TEXT NOT NULL,
        essay_set TEXT NOT NULL,
        essay_id TEXT,                     -- the essay the event is about, if any
        action_type TEXT NOT NULL,
        action_detail TEXT,                -- JSON (older research rows may hold plain text)
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id)
      )`,
    columns: [
      'id', 'session_id', 'participant_id', 'condition', 'essay_set', 'essay_id',
      'action_type', 'action_detail', 'timestamp',
    ],
  },
];

const TOPIC_ASSIGNMENTS = `
  CREATE TABLE topic_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,     -- also the order of assignments
    session_id TEXT NOT NULL,
    essay_id TEXT NOT NULL,
    topic_id INTEGER,                         -- NULL: the teacher removed the essay from its topic
    source TEXT NOT NULL CHECK (source IN ('model', 'manual')),
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (source = 'manual' OR topic_id IS NOT NULL),
    FOREIGN KEY (essay_id, session_id) REFERENCES essays(id, session_id),
    FOREIGN KEY (topic_id, session_id) REFERENCES topics(id, session_id)
  );
`;

const VIEWS_AND_INDEXES = `
  -- Current assignment of every assigned essay: its latest row.
  CREATE VIEW essay_current_topics AS
  SELECT ta.session_id, ta.essay_id, ta.topic_id, ta.source, ta.assigned_at
  FROM topic_assignments ta
  WHERE ta.id = (SELECT MAX(id) FROM topic_assignments latest WHERE latest.essay_id = ta.essay_id);

  -- Latest assignment of an essay (the view), and all assignments of a session (export).
  CREATE INDEX idx_topic_assignments_essay ON topic_assignments (essay_id, id);
  CREATE INDEX idx_topic_assignments_session ON topic_assignments (session_id, id);

  -- Stored vector length per model (dimension check).
  CREATE INDEX idx_essay_embeddings_model ON essay_embeddings (model, input_version, dimensions);

  -- Indexes of the rebuilt tables.
  CREATE INDEX idx_action_logs_session_time ON action_logs (session_id, timestamp);
  CREATE INDEX idx_action_logs_session_type ON action_logs (session_id, action_type, timestamp);
  CREATE INDEX idx_highlights_session_essay ON teacher_highlights (session_id, essay_id, start_index);
`;

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** Throws if existing rows can't be migrated without guessing. */
function checkExistingData(db: Database.Database): void {
  const problems: string[] = [];

  const texts = count(db, 'SELECT COUNT(DISTINCT rubric_content) AS n FROM sessions');
  if (texts > 1) problems.push(`sessions use ${texts} different rubric texts; only one rubric (essay-v1) is known`);

  const unused = count(db, `SELECT COUNT(*) AS n FROM sessions
    WHERE teacher_name IS NOT NULL OR rubric_criteria_json IS NOT NULL OR topic_method IS NOT NULL`);
  if (unused > 0) problems.push(`${unused} session(s) have values in teacher_name, rubric_criteria_json or topic_method`);

  const names = RUBRIC_V1.criteria.map((c) => `'${c.name}'`).join(', ');
  for (const table of ['grades', 'benchmarks', 'teacher_highlights']) {
    const unknown = count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE criterion_name NOT IN (${names})`);
    if (unknown > 0) problems.push(`${table}: ${unknown} row(s) with a criterion not in rubric essay-v1`);
  }
  const idOfName = `CASE criterion_name ${RUBRIC_V1.criteria.map((c) => `WHEN '${c.name}' THEN ${c.id}`).join(' ')} END`;
  const mismatched = count(db, `SELECT COUNT(*) AS n FROM grades WHERE criterion_id <> ${idOfName}`);
  if (mismatched > 0) problems.push(`grades: ${mismatched} row(s) whose criterion_id does not match criterion_name`);
  const types = count(db, 'SELECT COUNT(*) AS n FROM benchmarks WHERE benchmark_type <> CAST(score AS TEXT)');
  if (types > 0) problems.push(`benchmarks: ${types} row(s) whose benchmark_type is not the score`);

  if (problems.length > 0) throw new Error(problems.join('; '));
}

function insertRubricV1(db: Database.Database): void {
  const source = db.prepare('SELECT rubric_content AS text FROM sessions LIMIT 1').get() as { text: string } | undefined;
  if (!source) return; // new database: the rubric is stored with the first session

  db.prepare('INSERT INTO rubrics (id, source_text) VALUES (?, ?)').run(RUBRIC_V1.id, source.text);
  const criterion = db.prepare(`INSERT INTO rubric_criteria (rubric_id, criterion_id, name, position, min_score, max_score)
    VALUES (?, ?, ?, ?, 1, 5)`);
  const level = db.prepare('INSERT INTO rubric_levels (rubric_id, criterion_id, score, description) VALUES (?, ?, ?, ?)');
  RUBRIC_V1.criteria.forEach((c, i) => {
    criterion.run(RUBRIC_V1.id, c.id, c.name, i + 1);
    c.levels.forEach((description, s) => level.run(RUBRIC_V1.id, c.id, s + 1, description));
  });
}

function up(db: Database.Database): void {
  checkExistingData(db);
  db.exec(RUBRIC_TABLES);
  insertRubricV1(db);

  db.pragma('legacy_alter_table = ON');
  try {
    for (const { table } of REBUILDS) db.exec(`ALTER TABLE ${table} RENAME TO old_${table}`);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  for (const { create } of REBUILDS) db.exec(create);

  for (const { table, columns, select = {} } of REBUILDS) {
    const exprs = columns.map((c) => select[c] ?? `old.${c}`).join(', ');
    try {
      db.exec(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${exprs} FROM old_${table} AS old`);
    } catch (err) {
      throw new Error(`copying ${table}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Each essay's current topic becomes its first assignment.
  db.exec(TOPIC_ASSIGNMENTS);
  db.exec(`
    INSERT INTO topic_assignments (session_id, essay_id, topic_id, source, assigned_at)
    SELECT session_id, id, topic_id,
           CASE WHEN topic_manually_reassigned = 1 THEN 'manual' ELSE 'model' END,
           created_at
    FROM old_essays WHERE topic_id IS NOT NULL
    ORDER BY session_id, filename
  `);

  for (const { table } of [...REBUILDS].reverse()) db.exec(`DROP TABLE old_${table}`);
  db.exec(VIEWS_AND_INDEXES);
}

export const rubricsAndTopicAssignments: Migration = {
  version: 5,
  name: 'rubrics-and-topic-assignments',
  up,
};
