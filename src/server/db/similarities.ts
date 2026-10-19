import { getDb } from './client';

export interface SimilarEssay {
  essay_id: string;
  filename: string;
  similarity_score: number;
  grading_status: string;
  overall_grade: number | null;
  summary: string | null;
}

/** Replaces a session's neighbour rows in one transaction. Rows are directed (A -> B). */
export function replaceSimilarities(
  sessionId: string,
  rows: { essayIdA: string; essayIdB: string; score: number }[],
  embedding: { model: string; inputVersion: string },
): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO essay_similarities
      (session_id, essay_id_a, essay_id_b, similarity_score, embedding_model, embedding_input_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM essay_similarities WHERE session_id = ?').run(sessionId);
    for (const r of rows) insert.run(sessionId, r.essayIdA, r.essayIdB, r.score, embedding.model, embedding.inputVersion);
  })();
}

export function getSimilarEssays(sessionId: string, essayId: string, limit = 5): SimilarEssay[] {
  return getDb().prepare(`
    SELECT
      es.essay_id_b AS essay_id,
      'essay-' || e.dataset_essay_id AS filename,
      es.similarity_score,
      e.grading_status,
      s.overall_grade,
      e.summary
    FROM essay_similarities es
    JOIN essays e ON e.id = es.essay_id_b
    JOIN essay_scores s ON s.essay_id = e.id
    WHERE es.session_id = ? AND es.essay_id_a = ?
    ORDER BY es.similarity_score DESC
    LIMIT ?
  `).all(sessionId, essayId, limit) as SimilarEssay[];
}
