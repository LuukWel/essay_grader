// Research export: the stored data of a set of sessions, as flat rows.

import { getDb } from './client';
import type { ActionLogRow } from './action-logs';

export interface ExportRows {
  sessions: unknown[];
  rubricCriteria: unknown[];
  essays: unknown[];
  topicAssignments: unknown[];
  grades: unknown[];
  benchmarks: unknown[];
  similarities: unknown[];
  actionLogs: ActionLogRow[];
}

export function loadExportRows(sessionIds: string[]): ExportRows {
  const db = getDb();
  const ph = sessionIds.map(() => '?').join(',');
  const all = <T = unknown>(sql: string) => db.prepare(sql).all(...sessionIds) as T[];

  return {
    sessions: all(`
      SELECT id, participant_id, condition, essay_set, rubric_id, processing_status, created_at, completed_at
      FROM sessions WHERE id IN (${ph})`),
    rubricCriteria: all(`
      SELECT rc.rubric_id, rc.criterion_id, rc.name, rc.position, rc.min_score, rc.max_score
      FROM rubric_criteria rc
      WHERE rc.rubric_id IN (SELECT rubric_id FROM sessions WHERE id IN (${ph}))
      ORDER BY rc.rubric_id, rc.position`),
    essays: all(`
      SELECT e.id, e.session_id, e.dataset_essay_id, 'essay-' || e.dataset_essay_id AS filename,
             e.word_count, e.grading_status, s.overall_grade, e.summary,
             ct.topic_id, ct.source AS topic_source, e.is_flagged
      FROM essays e LEFT JOIN essay_current_topics ct ON ct.essay_id = e.id
      JOIN essay_scores s ON s.essay_id = e.id
      WHERE e.session_id IN (${ph}) ORDER BY e.session_id, e.dataset_essay_id`),
    topicAssignments: all(`
      SELECT session_id, essay_id, topic_id, source, assigned_at
      FROM topic_assignments WHERE session_id IN (${ph}) ORDER BY session_id, id`),
    grades: all(`
      SELECT g.session_id, g.essay_id, g.rubric_id, g.criterion_id, rc.name AS criterion_name,
             g.teacher_score, g.ai_score, g.original_ai_score,
             g.teacher_justification, g.ai_justification, g.graded_at
      FROM grades g JOIN rubric_criteria rc USING (rubric_id, criterion_id)
      WHERE g.session_id IN (${ph}) ORDER BY g.session_id, g.essay_id, rc.position`),
    benchmarks: all(`
      SELECT b.session_id, b.rubric_id, b.criterion_id, rc.name AS criterion_name, b.score, b.essay_id, b.set_at
      FROM benchmarks b JOIN rubric_criteria rc USING (rubric_id, criterion_id)
      WHERE b.session_id IN (${ph}) ORDER BY b.session_id, rc.position, b.score`),
    similarities: all(`
      SELECT session_id, essay_id_a, essay_id_b, similarity_score, embedding_model, embedding_input_version
      FROM essay_similarities WHERE session_id IN (${ph})
      ORDER BY session_id, essay_id_a, similarity_score DESC`),
    actionLogs: all<ActionLogRow>(`
      SELECT * FROM action_logs WHERE session_id IN (${ph}) ORDER BY session_id, timestamp`),
  };
}
