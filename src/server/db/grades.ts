import { getDb } from './client';

export interface Grade {
  id: number;
  session_id: string;
  essay_id: string;
  rubric_id: string;
  criterion_id: number;
  /** From rubric_criteria. */
  criterion_name: string;
  teacher_score: number | null;
  ai_score: number | null;
  /** The first AI score, kept when the AI score is later revised. */
  original_ai_score: number | null;
  teacher_justification: string | null;
  ai_justification: string | null;
  evidence_json: string | null;
  graded_at: string;
}

const GRADE_FIELDS = [
  'teacher_score', 'ai_score',
  'teacher_justification', 'ai_justification', 'evidence_json',
] as const;

/** Grades with their criterion's name, in rubric order. */
const GRADE_SELECT = `
  SELECT g.*, rc.name AS criterion_name
  FROM grades g JOIN rubric_criteria rc USING (rubric_id, criterion_id)`;

/**
 * Inserts or updates the grade for one essay and criterion. Fields left undefined keep their
 * stored value (null on a new row). rubric_id is taken from the session. SQLite records
 * the first non-null AI score and rejects later attempts to change that original.
 */
export function upsertGrade(
  sessionId: string,
  essayId: string,
  criterionId: number,
  data: {
    teacher_score?: number | null;
    ai_score?: number | null;
    teacher_justification?: string | null;
    ai_justification?: string | null;
    evidence_json?: string | null;
  },
): void {
  const given = GRADE_FIELDS.filter((f) => data[f] !== undefined);
  const updates = [...given.map((f) => `${f} = excluded.${f}`), 'graded_at = CURRENT_TIMESTAMP'].join(', ');

  const result = getDb().prepare(`
    INSERT INTO grades (session_id, essay_id, rubric_id, criterion_id, ${GRADE_FIELDS.join(', ')})
    SELECT s.id, ?, s.rubric_id, ?, ${GRADE_FIELDS.map(() => '?').join(', ')}
    FROM sessions s WHERE s.id = ?
    ON CONFLICT (session_id, essay_id, criterion_id) DO UPDATE SET ${updates}
  `).run(essayId, criterionId, ...GRADE_FIELDS.map((f) => data[f] ?? null), sessionId);
  if (result.changes === 0) throw new Error(`Session ${sessionId} not found`);
}

export function getGrades(sessionId: string, essayId: string): Grade[] {
  return getDb().prepare(`${GRADE_SELECT} WHERE g.session_id = ? AND g.essay_id = ? ORDER BY rc.position`)
    .all(sessionId, essayId) as Grade[];
}

export function getGradeForCriterion(sessionId: string, essayId: string, criterionId: number): Grade | null {
  return (getDb().prepare(`${GRADE_SELECT} WHERE g.session_id = ? AND g.essay_id = ? AND g.criterion_id = ?`)
    .get(sessionId, essayId, criterionId) as Grade) ?? null;
}
