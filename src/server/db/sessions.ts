import { randomUUID } from 'crypto';
import { getDb } from './client';

export interface Session {
  id: string;
  participant_id: string;
  condition: 'baseline' | 'dashboard';
  /** Name of the data/subset_<NAME>.csv file the essays came from */
  essay_set: string;
  use_precomputed_topics: number;
  /** Topic count k (research CSV and live topic model). */
  precomputed_k: number | null;
  precompute_grades: number;
  grades_precomputed: number;
  use_cached_assessments: number;
  assessment_type: string;
  assessment_length: string;
  /** The rubric the session is graded with (table `rubrics`). */
  rubric_id: string;
  /** The rubric's text (rubrics.source_text). */
  rubric_content: string;
  processing_status: string;
  created_at: string;
  completed_at: string | null;
}

export interface SessionStats {
  totalEssays: number;
  gradedEssays: number;
  avgGrade: number | null;
  gradeDistribution: Record<number, number>;
}

/** How far the background pipelines have got, counted from the stored results. */
export interface SessionProgress {
  total: number;
  summarised: number;
  topics: number;
  similarities: number;
}

export function createSession(
  participantId: string,
  condition: 'baseline' | 'dashboard',
  essaySet: string,
  rubricId: string,
  usePrecomputedTopics = false,
  precomputedK: number | null = null,
  precomputeGrades = true,
  useCachedAssessments = false,
  assessmentType = 'flow',
  assessmentLength = 'medium',
): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO sessions (id, participant_id, condition, essay_set, rubric_id, use_precomputed_topics, precomputed_k, precompute_grades, use_cached_assessments, assessment_type, assessment_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, participantId, condition, essaySet, rubricId, usePrecomputedTopics ? 1 : 0, precomputedK, precomputeGrades ? 1 : 0, useCachedAssessments ? 1 : 0, assessmentType, assessmentLength);
  return id;
}

/** A session with its rubric text. */
const SESSION_SELECT = `
  SELECT s.*, r.source_text AS rubric_content
  FROM sessions s JOIN rubrics r ON r.id = s.rubric_id`;

export function getSession(sessionId: string): Session | null {
  return (getDb().prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(sessionId) as Session) ?? null;
}

export function updateSessionStatus(sessionId: string, status: string): void {
  getDb().prepare('UPDATE sessions SET processing_status = ? WHERE id = ?').run(status, sessionId);
}

export function markGradesPrecomputed(sessionId: string): void {
  getDb().prepare('UPDATE sessions SET grades_precomputed = 1 WHERE id = ?').run(sessionId);
}

export function completeSession(sessionId: string): void {
  getDb().prepare('UPDATE sessions SET completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
}

export function findResumableSession(
  participantId: string,
  condition: 'baseline' | 'dashboard',
  essaySet: string,
): Session | null {
  return (getDb().prepare(`${SESSION_SELECT}
    WHERE s.participant_id = ? AND s.condition = ? AND s.essay_set = ? AND s.completed_at IS NULL
    ORDER BY s.created_at DESC LIMIT 1
  `).get(participantId, condition, essaySet) as Session) ?? null;
}

export function getSessionIdsForParticipant(participantId: string): string[] {
  const rows = getDb().prepare('SELECT id FROM sessions WHERE participant_id = ?').all(participantId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function getSessionProgress(sessionId: string): SessionProgress {
  return getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM essays WHERE session_id = :id)                             AS total,
      (SELECT COUNT(*) FROM essays WHERE session_id = :id AND summary IS NOT NULL)     AS summarised,
      (SELECT COUNT(*) FROM essay_current_topics
         WHERE session_id = :id AND topic_id IS NOT NULL)                                AS topics,
      (SELECT COUNT(DISTINCT essay_id_a) FROM essay_similarities WHERE session_id = :id) AS similarities
  `).get({ id: sessionId }) as SessionProgress;
}

export function getSessionStats(sessionId: string): SessionStats {
  const db = getDb();
  const { totalEssays, gradedEssays, avgGrade } = db.prepare(`
    SELECT COUNT(*) AS totalEssays,
           SUM(grading_status = 'graded') AS gradedEssays,
           AVG(CASE WHEN e.grading_status = 'graded' THEN s.overall_grade END) AS avgGrade
    FROM essays e JOIN essay_scores s ON s.essay_id = e.id WHERE e.session_id = ?
  `).get(sessionId) as { totalEssays: number; gradedEssays: number | null; avgGrade: number | null };

  // Buckets use the displayed /10 scale; criterion scores use /5.
  const rows = db.prepare(
    `SELECT ROUND(s.overall_grade * 2) as bucket, COUNT(*) as cnt
     FROM essays e JOIN essay_scores s ON s.essay_id = e.id
     WHERE e.session_id = ? AND e.grading_status = 'graded' AND s.overall_grade IS NOT NULL GROUP BY bucket`
  ).all(sessionId) as { bucket: number; cnt: number }[];

  const gradeDistribution: Record<number, number> = {};
  for (const row of rows) gradeDistribution[row.bucket] = row.cnt;

  return { totalEssays, gradedEssays: gradedEssays ?? 0, avgGrade, gradeDistribution };
}
