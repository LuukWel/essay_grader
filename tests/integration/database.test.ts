// Schema migrations and the constraints they add, on separate in-memory databases.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, migrate, schemaVersion } from '@/server/db/migrate';
import { MIGRATIONS } from '@/server/db/migrations';

const LATEST = MIGRATIONS.at(-1)!.version;

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * Two rubrics; sessions S1 and S2 both use R1. Topic 1 belongs to session S1; E1 and E2 are
 * essays of S1, E3 of S2.
 */
function seed(db: Database.Database) {
  db.exec(`
    INSERT INTO rubrics (id, source_text) VALUES ('R1', 'rubric one'), ('R2', 'rubric two');
    INSERT INTO rubric_criteria (rubric_id, criterion_id, name, position, min_score, max_score) VALUES
      ('R1', 1, 'Content', 1, 1, 5), ('R1', 2, 'Language', 2, 1, 5), ('R2', 3, 'Style', 1, 1, 5);
    INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_id)
      VALUES ('S1', 'P1', 'dashboard', 'X', 'R1'), ('S2', 'P2', 'baseline', 'X', 'R1');
    INSERT INTO topics (id, session_id, topic_index, keywords) VALUES (1, 'S1', 0, '[]');
    INSERT INTO essays (id, session_id, dataset_essay_id, source_path, essay_text) VALUES
      ('E1', 'S1', '1', 'x.csv', 'text one'),
      ('E2', 'S1', '2', 'x.csv', 'text two'),
      ('E3', 'S2', '1', 'x.csv', 'text one');
  `);
}

describe('migrate on a new database', () => {
  it('creates the schema at the latest version and is idempotent', () => {
    const db = freshDb();
    expect(schemaVersion(db)).toBe(LATEST);
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      'rubrics', 'rubric_criteria', 'rubric_levels', 'sessions', 'essays', 'topics', 'topic_assignments',
      'grades', 'benchmarks', 'teacher_highlights', 'essay_similarities', 'action_logs',
      'essay_summaries', 'essay_embeddings', 'ai_assessments', 'topic_models', 'pipeline_runs',
    ]));
    // No rebuild copies left, and empty migration-1 caches are dropped.
    expect(tableNames(db).filter((t) => t.startsWith('old_') || t.startsWith('legacy_'))).toEqual([]);
    // A new database stores its rubric with the first session.
    expect(count(db, 'rubrics')).toBe(0);
    expect(migrate(db)).toBe(LATEST);
  });

  it('refuses a database newer than the app', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 99');
    expect(() => migrate(db)).toThrow(/newer than this app supports/);
  });
});

describe('constraints', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seed(db);
  });

  const insertGrade = (essayId: string, sessionId = 'S1', teacherScore: number | null = 3, rubricId = 'R1', criterionId = 1) =>
    db.prepare(`INSERT INTO grades (session_id, essay_id, rubric_id, criterion_id, teacher_score)
                VALUES (?, ?, ?, ?, ?)`).run(sessionId, essayId, rubricId, criterionId, teacherScore);

  it('rejects a grade for a missing essay or an essay of another session', () => {
    expect(() => insertGrade('NOPE')).toThrow('FOREIGN KEY constraint failed');
    expect(() => insertGrade('E3', 'S1')).toThrow('FOREIGN KEY constraint failed'); // E3 is in S2
    expect(() => insertGrade('E1', 'S1')).not.toThrow();
  });

  it('only accepts criteria of the rubric of the session', () => {
    expect(() => insertGrade('E1', 'S1', 3, 'R1', 9)).toThrow('FOREIGN KEY constraint failed'); // no such criterion
    expect(() => insertGrade('E1', 'S1', 3, 'R2', 3)).toThrow('FOREIGN KEY constraint failed'); // S1 uses R1
    expect(() => db.exec(`INSERT INTO benchmarks (session_id, rubric_id, criterion_id, score, essay_id)
                          VALUES ('S1', 'R2', 3, 4, 'E1')`)).toThrow('FOREIGN KEY constraint failed');
    expect(() => db.exec(`INSERT INTO teacher_highlights (session_id, essay_id, rubric_id, criterion_id, start_index, end_index, text)
                          VALUES ('S1', 'E1', 'R2', 3, 0, 4, 'text')`)).toThrow('FOREIGN KEY constraint failed');
    expect(() => insertGrade('E1', 'S1', 3, 'R1', 2)).not.toThrow();
  });

  it('keeps a rubric consistent: unique names, a valid scale, levels only for its own criteria', () => {
    const criterion = db.prepare(`INSERT INTO rubric_criteria (rubric_id, criterion_id, name, position, min_score, max_score)
                                  VALUES ('R1', 5, ?, 3, ?, ?)`);
    expect(() => criterion.run('Content', 1, 5)).toThrow('UNIQUE constraint failed');
    expect(() => criterion.run('Voice', 4, 2)).toThrow('CHECK constraint failed');
    expect(() => db.exec(`INSERT INTO rubric_levels (rubric_id, criterion_id, score, description)
                          VALUES ('R1', 3, 1, 'Weak')`)).toThrow('FOREIGN KEY constraint failed'); // criterion 3 is R2's
    expect(() => db.exec(`INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_id)
                          VALUES ('S3', 'P', 'baseline', 'X', 'R9')`)).toThrow('FOREIGN KEY constraint failed');
  });

  it('allows one grade per essay and criterion, and one benchmark per criterion and score', () => {
    insertGrade('E1');
    expect(() => insertGrade('E1')).toThrow('UNIQUE constraint failed');
    const benchmark = db.prepare(`INSERT INTO benchmarks (session_id, rubric_id, criterion_id, score, essay_id)
                                  VALUES ('S1', 'R1', 1, 4, ?)`);
    benchmark.run('E1');
    expect(() => benchmark.run('E2')).toThrow('UNIQUE constraint failed');
  });

  it('keeps scores in the 1-5 range, allowing null for "not scored yet"', () => {
    expect(() => insertGrade('E1', 'S1', 6)).toThrow('score outside criterion range');
    expect(() => insertGrade('E2', 'S1', 0)).toThrow('score outside criterion range');
    expect(() => insertGrade('E2', 'S1', null)).not.toThrow();
  });

  it('allows one essay per dataset ID per session', () => {
    expect(() => db.exec(`INSERT INTO essays (id, session_id, dataset_essay_id, source_path, essay_text)
                          VALUES ('E4', 'S1', '1', 'x.csv', 'dup')`)).toThrow('UNIQUE constraint failed');
  });

  it('only assigns topics of the essay\'s own session, and keeps every assignment', () => {
    const assign = db.prepare('INSERT INTO topic_assignments (session_id, essay_id, topic_id, source) VALUES (?, ?, ?, ?)');
    expect(() => assign.run('S2', 'E3', 1, 'model')).toThrow('FOREIGN KEY constraint failed'); // topic 1 is S1's
    expect(() => assign.run('S1', 'E1', null, 'model')).toThrow('CHECK constraint failed'); // the model always picks one
    expect(() => assign.run('S1', 'E1', 1, 'teacher')).toThrow('CHECK constraint failed');

    assign.run('S1', 'E1', 1, 'model');
    assign.run('S1', 'E1', null, 'manual');
    expect(count(db, 'topic_assignments')).toBe(2);
    expect(db.prepare("SELECT topic_id, source FROM essay_current_topics WHERE essay_id = 'E1'").get())
      .toEqual({ topic_id: null, source: 'manual' });
  });

  it('checks status values, highlight ranges and similarity scores', () => {
    expect(() => db.exec("UPDATE essays SET grading_status = 'done' WHERE id = 'E1'")).toThrow('CHECK constraint failed');
    expect(() => db.exec(`INSERT INTO teacher_highlights (session_id, essay_id, rubric_id, criterion_id, start_index, end_index, text)
                          VALUES ('S1', 'E1', 'R1', 1, 5, 5, '')`)).toThrow('CHECK constraint failed');
    const similarity = db.prepare(`INSERT INTO essay_similarities
      (session_id, essay_id_a, essay_id_b, similarity_score, embedding_model, embedding_input_version)
      VALUES ('S1', ?, ?, ?, ?, ?)`);
    expect(() => similarity.run('E1', 'E2', 1.5, 'm', 'v1')).toThrow('CHECK constraint failed');
    expect(() => similarity.run('E1', 'E1', 1, 'm', 'v1')).toThrow('CHECK constraint failed');
    expect(() => similarity.run('E1', 'E2', 0.8, 'm', null)).toThrow('CHECK constraint failed'); // model without version
    expect(() => similarity.run('E1', 'E2', 0.8, 'm', 'v1')).not.toThrow();
  });

  it('only logs events about essays of the same session', () => {
    const log = db.prepare(`INSERT INTO action_logs (session_id, participant_id, condition, essay_set, essay_id, action_type)
                            VALUES ('S1', 'P1', 'dashboard', 'X', ?, 'essay_opened')`);
    expect(() => log.run('E3')).toThrow('FOREIGN KEY constraint failed');
    expect(() => log.run('E1')).not.toThrow();
    expect(() => log.run(null)).not.toThrow();
  });

  it('keeps an embedding\'s vector length equal to its dimension count', () => {
    const embed = db.prepare(`INSERT INTO essay_embeddings (cache_key, content_hash, model, input_version, dimensions, embedding_json)
                              VALUES (?, 'h', 'm', 'v1', ?, ?)`);
    expect(() => embed.run('k1', 3, '[0.1, 0.2]')).toThrow('CHECK constraint failed');
    expect(() => embed.run('k2', 2, '[0.1, 0.2]')).not.toThrow();
  });

  it('rejects evidence that is not valid JSON', () => {
    expect(() => db.exec(`INSERT INTO grades (session_id, essay_id, rubric_id, criterion_id, evidence_json)
                          VALUES ('S1', 'E1', 'R1', 1, '[{"quote":')`)).toThrow('CHECK constraint failed');
  });
});

describe('query plans', () => {
  // Main per-session queries; none should scan a table or sort.
  const queries: [string, string][] = [
    ['essays of a session with their current topic and scores', `SELECT e.*, ct.topic_id, s.overall_grade, s.avg_ai_score FROM essays e
      LEFT JOIN essay_current_topics ct ON ct.essay_id = e.id JOIN essay_scores s ON s.essay_id = e.id
      WHERE e.session_id = ? ORDER BY e.dataset_essay_id`],
    ['grades of an essay', `SELECT g.*, rc.name FROM grades g JOIN rubric_criteria rc USING (rubric_id, criterion_id)
      WHERE g.session_id = ? AND g.essay_id = ?`],
    ['criteria of a rubric', 'SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY position'],
    ['topics of a session', 'SELECT * FROM topics WHERE session_id = ? ORDER BY topic_index'],
    ['topic assignments of a session', 'SELECT * FROM topic_assignments WHERE session_id = ? ORDER BY id'],
    ['similar essays', 'SELECT * FROM essay_similarities WHERE session_id = ? AND essay_id_a = ? ORDER BY similarity_score DESC'],
    ['benchmarks of a criterion', 'SELECT * FROM benchmarks WHERE session_id = ? AND criterion_id = ? ORDER BY score'],
    ['highlights of an essay', 'SELECT * FROM teacher_highlights WHERE session_id = ? AND essay_id = ? ORDER BY start_index'],
    ['embedding dimensions of a model', 'SELECT DISTINCT dimensions FROM essay_embeddings WHERE model = ? AND input_version = ?'],
    ['session log export', 'SELECT * FROM action_logs WHERE session_id = ? ORDER BY timestamp'],
    ['rank history', "SELECT action_detail FROM action_logs WHERE session_id = ? AND action_type = 'quality_rank_updated' ORDER BY timestamp"],
  ];

  it.each(queries)('%s uses an index', (_, sql) => {
    const db = freshDb();
    const params = (sql.match(/\?/g) ?? []).map(() => 'x');
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
    expect(plan.join(' | ')).toMatch(/USING (COVERING )?(INDEX|PRIMARY KEY)/);
    expect(plan.join(' | ')).not.toMatch(/^SCAN|\| SCAN/);
    // "similar essays" sorts at most 5 rows; the others read in index order.
    if (!sql.includes('similarity_score DESC')) expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
  });
});

// A database from before migrations existed (user_version 0, older columns).
const LEGACY_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, participant_id TEXT NOT NULL,
    condition TEXT NOT NULL CHECK(condition IN ('baseline', 'dashboard')),
    essay_set TEXT NOT NULL, teacher_name TEXT, rubric_content TEXT NOT NULL,
    rubric_criteria_json TEXT, topic_method TEXT,
    use_precomputed_topics INTEGER NOT NULL DEFAULT 0, precomputed_k INTEGER,
    processing_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME);
  CREATE TABLE essays (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    filename TEXT NOT NULL, pdf_path TEXT NOT NULL, pdf_content TEXT NOT NULL, summary TEXT,
    word_count INTEGER, topic_id INTEGER, topic_manually_reassigned INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0, grading_status TEXT DEFAULT 'pending', overall_grade REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    topic_index INTEGER NOT NULL, keywords TEXT NOT NULL, label TEXT);
  CREATE TABLE grades (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, essay_id TEXT NOT NULL,
    criterion_name TEXT NOT NULL, criterion_id INTEGER NOT NULL, teacher_score INTEGER, ai_score INTEGER,
    original_ai_score INTEGER, teacher_justification TEXT, ai_justification TEXT, evidence_json TEXT,
    graded_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE benchmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    criterion_name TEXT NOT NULL, essay_id TEXT NOT NULL,
    benchmark_type TEXT NOT NULL CHECK(benchmark_type IN ('low', 'high')), score INTEGER NOT NULL,
    teacher_justification TEXT, ai_justification TEXT, set_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, criterion_name, benchmark_type));
  CREATE TABLE action_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, condition TEXT NOT NULL, essay_set TEXT NOT NULL, essay_id TEXT,
    action_type TEXT NOT NULL, action_detail TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE essay_summary_cache (tsv_id TEXT PRIMARY KEY, summary TEXT NOT NULL, embedding_json TEXT);

  INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_content, processing_status)
    VALUES ('S1', 'P1', 'dashboard', 'C', 'rubric', NULL);
  INSERT INTO topics (id, session_id, topic_index, keywords, label) VALUES (7, 'S1', 0, '["a"]', 'Topic');
  INSERT INTO essays (id, session_id, filename, pdf_path, pdf_content, topic_id, grading_status, overall_grade)
    VALUES ('E1', 'S1', 'essay-1', 'c.csv', 'text', 7, 'graded', 3.5),
           ('E2', 'S1', 'essay-2', 'c.csv', 'text', NULL, NULL, NULL);
  INSERT INTO grades (session_id, essay_id, criterion_name, criterion_id, teacher_score, ai_score, evidence_json)
    VALUES ('S1', 'E1', 'Content', 1, 4, 3, '[]');
  INSERT INTO benchmarks (session_id, criterion_name, essay_id, benchmark_type, score)
    VALUES ('S1', 'Content', 'E1', 'high', 4);
  INSERT INTO action_logs (session_id, participant_id, condition, essay_set, essay_id, action_type)
    VALUES ('S1', 'P1', 'dashboard', 'C', NULL, 'session_start'), ('S1', 'P1', 'dashboard', 'C', 'E1', 'essay_opened');
  INSERT INTO essay_summary_cache VALUES ('1', 'A summary.', '[0.1, 0.2]');
`;

function legacyDb(extraSql = '') {
  const db = new Database(':memory:');
  db.exec(LEGACY_SCHEMA + extraSql);
  return db;
}

describe('migrate on a database from before migrations', () => {
  it('upgrades it to the latest version without losing rows', () => {
    const db = legacyDb();
    expect(migrate(db)).toBe(LATEST);

    expect(db.prepare('SELECT * FROM sessions').get()).toMatchObject({
      id: 'S1', rubric_id: 'essay-v1', processing_status: 'pending',
      assessment_type: 'flow', assessment_length: 'medium', precompute_grades: 1,
    });
    expect(db.prepare("SELECT e.grading_status, s.overall_grade, s.avg_ai_score FROM essays e JOIN essay_scores s ON s.essay_id = e.id WHERE e.id = 'E1'").get())
      .toEqual({ grading_status: 'graded', overall_grade: 4, avg_ai_score: 3 });
    expect(db.prepare("SELECT grading_status FROM essays WHERE id = 'E2'").get()).toEqual({ grading_status: 'pending' });
    expect(db.prepare('SELECT rubric_id, criterion_id, teacher_score, ai_score FROM grades').get())
      .toEqual({ rubric_id: 'essay-v1', criterion_id: 1, teacher_score: 4, ai_score: 3 });
    expect(count(db, 'action_logs')).toBe(2);
  });

  it('stores the rubric the existing sessions used as essay-v1', () => {
    const db = legacyDb();
    migrate(db);
    expect(db.prepare('SELECT id, source_text FROM rubrics').all()).toEqual([{ id: 'essay-v1', source_text: 'rubric' }]);
    expect(db.prepare('SELECT name FROM rubric_criteria ORDER BY position').all())
      .toEqual([{ name: 'Content' }, { name: 'Organization' }, { name: 'Language' }]);
    expect(count(db, 'rubric_levels')).toBe(15);
  });

  it('turns each essay\'s topic into its first topic assignment, keeping who made it', () => {
    const db = legacyDb("UPDATE essays SET topic_id = 7, topic_manually_reassigned = 1 WHERE id = 'E2';");
    migrate(db);
    expect(db.prepare('SELECT essay_id, topic_id, source FROM essay_current_topics ORDER BY essay_id').all()).toEqual([
      { essay_id: 'E1', topic_id: 7, source: 'model' },
      { essay_id: 'E2', topic_id: 7, source: 'manual' },
    ]);
  });

  it('keeps migration-1 cache rows as legacy provenance, apart from the keyed results', () => {
    const db = legacyDb();
    migrate(db);
    // No model or prompt recorded, so it can't get an input-based key.
    expect(db.prepare('SELECT tsv_id, summary FROM legacy_essay_summary_cache').get()).toEqual({ tsv_id: '1', summary: 'A summary.' });
    expect(count(db, 'essay_summaries')).toBe(0);
  });

  it('keeps an early low/high benchmarks table under a new name instead of dropping it', () => {
    const db = legacyDb();
    migrate(db);
    expect(db.prepare('SELECT benchmark_type, score FROM benchmarks_legacy_low_high').all())
      .toEqual([{ benchmark_type: 'high', score: 4 }]);
    expect(count(db, 'benchmarks')).toBe(0);
  });

  it('stops with a clear error and changes nothing when rows break a new rule', () => {
    const db = legacyDb(`
      INSERT INTO grades (session_id, essay_id, criterion_name, criterion_id, teacher_score)
        VALUES ('S1', 'E1', 'Content', 1, 5);
    `);

    expect(() => migrate(db)).toThrow(MigrationError);
    expect(() => migrate(db)).toThrow(/integrity.*copying grades: UNIQUE constraint failed/);

    // Migration 1 committed, migration 2 rolled back.
    expect(schemaVersion(db)).toBe(1);
    expect(count(db, 'grades')).toBe(2);
    expect(tableNames(db).filter((t) => t.startsWith('old_'))).toEqual([]);
  });

  it('reports rows that point at missing parents', () => {
    const db = legacyDb(`
      INSERT INTO grades (session_id, essay_id, criterion_name, criterion_id) VALUES ('S1', 'GONE', 'Language', 3);
    `);
    expect(() => migrate(db)).toThrow('grades: 1 row(s) reference a missing row in essays');
    expect(schemaVersion(db)).toBe(1);
  });

  it.each([
    ['two rubric texts', `INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_content)
       VALUES ('S2', 'P2', 'baseline', 'C', 'another rubric');`, /2 different rubric texts/],
    ['a criterion outside the rubric', `INSERT INTO grades (session_id, essay_id, criterion_name, criterion_id)
       VALUES ('S1', 'E2', 'Style', 4);`, /grades: 1 row\(s\) with a criterion not in rubric essay-v1/],
    ['a value in a dropped column', "UPDATE sessions SET topic_method = 'bertopic';", /teacher_name, rubric_criteria_json or topic_method/],
    ['a log event about an essay of another session', `
       INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_content) VALUES ('S2', 'P2', 'baseline', 'C', 'rubric');
       INSERT INTO action_logs (session_id, participant_id, condition, essay_set, essay_id, action_type)
         VALUES ('S2', 'P2', 'baseline', 'C', 'E1', 'essay_opened');`, /action_logs: 1 row\(s\) reference a missing row in essays/],
  ])('does not guess when the rubric migration meets %s', (_, extraSql, error) => {
    const db = legacyDb(extraSql);
    expect(() => migrate(db)).toThrow(error);
    expect(schemaVersion(db)).toBe(4); // migrations 1-4 applied, migration 5 rolled back
    expect(tableNames(db)).not.toContain('rubrics');
  });
});
