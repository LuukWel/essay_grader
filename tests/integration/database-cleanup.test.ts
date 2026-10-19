import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, schemaVersion } from '@/server/db/migrate';
import { MIGRATIONS } from '@/server/db/migrations';
import { getDb } from '@/server/db/client';
import { getEssay, getEssaysBySession, updateEssayGrade } from '@/server/db/essays';
import { getGrades, upsertGrade } from '@/server/db/grades';
import { getSessionStats } from '@/server/db/sessions';
import { loadExportRows } from '@/server/db/exports';
import { validateGradeUpdate } from '@/server/validation/grade';
import { validateEssayUpdate } from '@/server/validation/essay';
import { RUBRIC_CRITERIA } from '@/lib/llm-config';
import { createTestSession } from '../helpers';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function version5() {
  const db = new Database(':memory:');
  opened.push(db);
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS.filter((m) => m.version <= 5));
  db.exec(`
    INSERT INTO rubrics(id, source_text) VALUES ('R', 'Rubric');
    INSERT INTO rubric_criteria VALUES ('R', 1, 'Argument', 1, 1, 5);
    INSERT INTO rubric_levels VALUES ('R', 1, 1, 'Weak');
    INSERT INTO sessions(id, participant_id, condition, essay_set, rubric_id)
      VALUES ('S', 'P', 'dashboard', 'DEMO', 'R');
    INSERT INTO essays(id, session_id, filename, pdf_path, pdf_content, overall_grade, avg_ai_score)
      VALUES ('E', 'S', 'essay-source-A', 'input.csv', 'An essay.', 5, 5);
    INSERT INTO topics(id, session_id, topic_index, keywords) VALUES (1, 'S', 0, '[]');
    INSERT INTO topic_assignments(session_id, essay_id, topic_id, source) VALUES ('S', 'E', 1, 'model');
  `);
  return db;
}

describe('migration 6', () => {
  it('preserves source data, grades, relationships, cache rows and ID sequences', () => {
    const db = version5();
    db.exec(`
      INSERT INTO grades(id, session_id, essay_id, rubric_id, criterion_id, teacher_score, ai_score, original_ai_score)
        VALUES (7, 'S', 'E', 'R', 1, 4, 3, 2);
      INSERT INTO benchmarks(session_id, rubric_id, criterion_id, score, essay_id) VALUES ('S', 'R', 1, 4, 'E');
      INSERT INTO teacher_highlights(session_id, essay_id, rubric_id, criterion_id, start_index, end_index, text)
        VALUES ('S', 'E', 'R', 1, 0, 2, 'An');
      INSERT INTO action_logs(session_id, participant_id, condition, essay_set, essay_id, action_type)
        VALUES ('S', 'P', 'dashboard', 'DEMO', 'E', 'essay_opened');
      INSERT INTO essay_summaries VALUES ('summary', 'h', 'model', 1, 'Summary.', CURRENT_TIMESTAMP);
      INSERT INTO essay_embeddings VALUES ('vector', 'h', 'model', 'v1', 2, '[0.1,0.2]', CURRENT_TIMESTAMP);
      INSERT INTO ai_assessments(cache_key, content_hash, criterion_id, criterion_hash, model, prompt_version,
        assessment_type, assessment_length, status, score, justification)
        VALUES ('assessment', 'h', 1, 'c', 'model', 1, 'flow', 'medium', 'success', 3, 'Reason');
      INSERT INTO topic_models(cache_key, essay_set, input_hash, k, embed_model, llm_model, method_version, topics_json, assignments_json)
        VALUES ('topics', 'DEMO', 'h', 2, 'embed', 'label', 1, '[]', '{}');
      INSERT INTO pipeline_runs(session_id, pipeline_type, status, instance_id, input_hash, config_json, expected_items)
        VALUES ('S', 'cohort_processing', 'running', 'instance', 'h', '{}', 1);
      INSERT INTO topic_assignments(id, session_id, essay_id, topic_id, source) VALUES (50, 'S', 'E', 1, 'manual');
      DELETE FROM topic_assignments WHERE id = 50;
    `);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name);
    const counts = () => tables.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get());
    const before = counts();
    const timestamps = db.prepare('SELECT created_at FROM essays').all();
    expect(migrate(db)).toBe(6);
    expect(counts()).toEqual(before);
    expect(db.prepare('SELECT created_at FROM essays').all()).toEqual(timestamps);
    expect(db.prepare('SELECT id, dataset_essay_id, source_path, essay_text FROM essays').get())
      .toEqual({ id: 'E', dataset_essay_id: 'source-A', source_path: 'input.csv', essay_text: 'An essay.' });
    expect(db.prepare('SELECT * FROM essay_scores').get()).toEqual({ essay_id: 'E', overall_grade: 4, avg_ai_score: 3 });
    expect(db.prepare('SELECT id, original_ai_score FROM grades').get()).toEqual({ id: 7, original_ai_score: 2 });
    expect(db.prepare('SELECT topic_id FROM essay_current_topics').get()).toEqual({ topic_id: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare("INSERT INTO topic_assignments(session_id, essay_id, topic_id, source) VALUES ('S', 'E', NULL, 'manual')").run().lastInsertRowid).toBe(51);
    expect(migrate(db)).toBe(6);
  });

  it.each([
    ['fractional score', "INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, teacher_score) VALUES ('S', 'E', 'R', 1, 3.5)"],
    ['out-of-range rubric level', "INSERT INTO rubric_levels VALUES ('R', 1, 99, 'Invalid')"],
    ['null primary key', "INSERT INTO rubrics(id, source_text) VALUES (NULL, 'Invalid')"],
    ['evidence object', "INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, evidence_json) VALUES ('S', 'E', 'R', 1, '{}')"],
    ['invalid topic JSON', "UPDATE topics SET keywords = 'not JSON'"],
  ])('rolls back and reports the problem for an existing %s', (_, sql) => {
    const db = version5();
    db.exec(sql);
    const essays = db.prepare('SELECT * FROM essays').all();
    const grades = db.prepare('SELECT * FROM grades').all();
    expect(() => migrate(db)).toThrow(/migration 6.*(copying|outside its criterion range)/);
    expect(schemaVersion(db)).toBe(5);
    expect(db.prepare('SELECT * FROM essays').all()).toEqual(essays);
    expect(db.prepare('SELECT * FROM grades').all()).toEqual(grades);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'old_%'").all()).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT topic_id FROM essay_current_topics').get()).toEqual({ topic_id: 1 });
  });
});

describe('database consistency', () => {
  function fresh() {
    const db = version5();
    migrate(db);
    return db;
  }

  it('requires non-null text primary keys in all seven affected tables', () => {
    const db = fresh();
    for (const sql of [
      "INSERT INTO rubrics(id, source_text) VALUES (NULL, 'Rubric')",
      "INSERT INTO sessions(id, participant_id, condition, essay_set, rubric_id) VALUES (NULL, 'P', 'baseline', 'DEMO', 'R')",
      "INSERT INTO essays(id, session_id, dataset_essay_id, source_path, essay_text) VALUES (NULL, 'S', 'other', 'x.csv', 'Text')",
      "INSERT INTO essay_summaries(cache_key, content_hash, model, prompt_version, summary) VALUES (NULL, 'h', 'm', 1, 'Summary')",
      "INSERT INTO essay_embeddings(cache_key, content_hash, model, input_version, dimensions, embedding_json) VALUES (NULL, 'h', 'm', 'v1', 1, '[1]')",
      "INSERT INTO ai_assessments(cache_key, content_hash, criterion_id, criterion_hash, model, prompt_version, assessment_type, assessment_length, status, error) VALUES (NULL, 'h', 1, 'c', 'm', 1, 'flow', 'medium', 'failed', 'Error')",
      "INSERT INTO topic_models(cache_key, essay_set, input_hash, k, embed_model, llm_model, method_version, topics_json, assignments_json) VALUES (NULL, 'DEMO', 'h', 2, 'e', 'm', 1, '[]', '{}')",
    ]) expect(() => db.exec(sql)).toThrow('NOT NULL constraint failed');
  });

  it('enforces integer scores, criterion ranges and JSON container types on direct SQL writes', () => {
    const db = fresh();
    expect(() => db.exec("INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, teacher_score) VALUES ('S', 'E', 'R', 1, 3.5)"))
      .toThrow('CHECK constraint failed');
    expect(() => db.exec("INSERT INTO rubric_levels VALUES ('R', 1, 99, 'Invalid')")).toThrow('score outside criterion range');
    expect(() => db.exec("UPDATE rubric_levels SET score = 2.5")).toThrow('CHECK constraint failed');
    expect(() => db.exec("UPDATE topics SET keywords = '{}' ")).toThrow('CHECK constraint failed');
    db.exec("UPDATE rubric_criteria SET max_score = 4 WHERE rubric_id = 'R'");
    expect(() => db.exec("INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, ai_score) VALUES ('S', 'E', 'R', 1, 5)"))
      .toThrow('score outside criterion range');
    db.exec("INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, ai_score) VALUES ('S', 'E', 'R', 1, 4)");
    expect(() => db.exec("UPDATE rubric_criteria SET max_score = 3 WHERE rubric_id = 'R'"))
      .toThrow('criterion range excludes existing scores');
    expect(() => db.exec("UPDATE grades SET evidence_json = '{}' ")).toThrow('CHECK constraint failed');
    expect(() => db.exec("INSERT INTO benchmarks(session_id, rubric_id, criterion_id, score, essay_id) VALUES ('S', 'R', 1, 5, 'E')"))
      .toThrow('score outside criterion range');
  });

  it('records the first AI score on insert or later assignment and prevents replacement or clearing', () => {
    const db = fresh();
    db.exec("INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, teacher_score) VALUES ('S', 'E', 'R', 1, 4)");
    db.exec('UPDATE grades SET ai_score = 2');
    db.exec('UPDATE grades SET ai_score = 5');
    expect(db.prepare('SELECT ai_score, original_ai_score FROM grades').get()).toEqual({ ai_score: 5, original_ai_score: 2 });
    for (const value of ['4', 'NULL']) {
      expect(() => db.exec(`UPDATE grades SET original_ai_score = ${value}`)).toThrow('original AI score cannot change');
    }
    db.exec('UPDATE grades SET ai_score = NULL');
    expect(db.prepare('SELECT original_ai_score FROM grades').get()).toEqual({ original_ai_score: 2 });
    db.exec('DELETE FROM grades');
    db.exec("INSERT INTO grades(session_id, essay_id, rubric_id, criterion_id, ai_score) VALUES ('S', 'E', 'R', 1, 3)");
    expect(db.prepare('SELECT original_ai_score FROM grades').get()).toEqual({ original_ai_score: 3 });
  });

  it('derives averages after inserts, edits, null clears and deletes across reads and exports', () => {
    const sessionId = createTestSession({ A: 'An essay.' });
    const essayId = getEssaysBySession(sessionId)[0].id;
    upsertGrade(sessionId, essayId, 1, { teacher_score: 3, ai_score: 2 });
    upsertGrade(sessionId, essayId, 2, { teacher_score: 4, ai_score: 5 });
    expect(getEssay(essayId)).toMatchObject({ overall_grade: 3.5, avg_ai_score: 3.5 });
    upsertGrade(sessionId, essayId, 1, { teacher_score: 5, ai_score: null });
    expect(getEssay(essayId)).toMatchObject({ overall_grade: 4.5, avg_ai_score: 5 });
    expect(getSessionStats(sessionId)).toMatchObject({ avgGrade: null, gradeDistribution: {} });
    updateEssayGrade(essayId, 'graded');
    expect(getSessionStats(sessionId).avgGrade).toBe(4.5);
    expect(loadExportRows([sessionId]).essays).toMatchObject([{ dataset_essay_id: 'A', filename: 'essay-A', overall_grade: 4.5 }]);
    expect(getGrades(sessionId, essayId)[0].original_ai_score).toBe(2);
    getDb().prepare('DELETE FROM grades WHERE session_id = ? AND criterion_id = 2').run(sessionId);
    expect(getEssay(essayId)).toMatchObject({ overall_grade: 5, avg_ai_score: null });
    upsertGrade(sessionId, essayId, 1, { teacher_score: null });
    expect(getEssay(essayId)).toMatchObject({ overall_grade: null, avg_ai_score: null });
  });

  it('ignores client attempts to supply an original score or authoritative average', () => {
    const criteria = RUBRIC_CRITERIA;
    const grade = validateGradeUpdate({ essayId: 'E', criterionName: 'Content', criterionId: 1, ai_score: 3, original_ai_score: 5 }, {
      sessionId: 'S', criteria, getEssay: () => ({ id: 'E', session_id: 'S', essay_text: 'Text' }),
    });
    expect(grade.ok && grade.value.fields).toEqual({ ai_score: 3 });
    expect(validateEssayUpdate({ grading_status: 'graded', overall_grade: 5 }, { criteria, topicIds: [] }))
      .toEqual({ ok: true, value: { grading: { status: 'graded' } } });
  });
});
