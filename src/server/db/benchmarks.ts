import { getDb } from './client';

export interface Benchmark {
  id: number;
  session_id: string;
  rubric_id: string;
  criterion_id: number;
  /** From rubric_criteria. */
  criterion_name: string;
  essay_id: string;
  score: number;
  /** Score as a string; the client uses it as the slot key. */
  benchmark_type: string;
  teacher_justification: string | null;
  ai_justification: string | null;
  set_at: string;
}

export interface BenchmarkWithEssay extends Benchmark {
  filename: string | null;
  summary: string | null;
}

/** Sets (or replaces) the benchmark essay for one criterion and score. */
export function setBenchmark(
  sessionId: string,
  criterionId: number,
  score: number,
  essayId: string,
  justifications: { teacher?: string | null; ai?: string | null },
): void {
  const result = getDb().prepare(`
    INSERT INTO benchmarks (session_id, rubric_id, criterion_id, score, essay_id, teacher_justification, ai_justification)
    SELECT s.id, s.rubric_id, ?, ?, ?, ?, ? FROM sessions s WHERE s.id = ?
    ON CONFLICT (session_id, criterion_id, score) DO UPDATE SET
      essay_id = excluded.essay_id,
      teacher_justification = excluded.teacher_justification,
      ai_justification = excluded.ai_justification,
      set_at = CURRENT_TIMESTAMP
  `).run(criterionId, score, essayId, justifications.teacher ?? null, justifications.ai ?? null, sessionId);
  if (result.changes === 0) throw new Error(`Session ${sessionId} not found`);
}

/** Benchmarks of one criterion, with the essay's filename and summary. */
export function getBenchmarks(sessionId: string, criterionId: number): BenchmarkWithEssay[] {
  return getDb().prepare(`
    SELECT b.*, rc.name AS criterion_name, CAST(b.score AS TEXT) AS benchmark_type, e.filename, e.summary
    FROM benchmarks b
    JOIN rubric_criteria rc USING (rubric_id, criterion_id)
    JOIN essays e ON e.id = b.essay_id
    WHERE b.session_id = ? AND b.criterion_id = ?
    ORDER BY b.score
  `).all(sessionId, criterionId) as BenchmarkWithEssay[];
}

export function removeBenchmark(sessionId: string, criterionId: number, score: number): void {
  getDb().prepare('DELETE FROM benchmarks WHERE session_id = ? AND criterion_id = ? AND score = ?')
    .run(sessionId, criterionId, score);
}
