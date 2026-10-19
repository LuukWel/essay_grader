import { randomUUID } from 'crypto';
import type { EssayMeta } from '@/types';
import { getDb } from './client';

export interface Essay {
  id: string;
  session_id: string;
  /** "essay-<dataset id>" */
  filename: string;
  pdf_path: string;
  essay_prompt: string | null;
  /** The essay text. */
  pdf_content: string;
  summary: string | null;
  word_count: number | null;
  /** Current topic (latest row in topic_assignments), or null. */
  topic_id: number | null;
  is_flagged: number;
  grading_status: string;
  overall_grade: number | null;
  avg_ai_score: number | null;
  created_at: string;
}

/** The essay's dataset ID (CSV `id` column), stored in `filename` as "essay-<id>". */
export function datasetId(essay: Pick<Essay, 'filename'>): string {
  return essay.filename.replace(/^essay-/, '');
}

export interface QualityRank {
  essayId: string;
  avgAiScore: number | null;
  rank: number;
}

export function createEssay(
  sessionId: string,
  filename: string,
  pdfPath: string,
  pdfContent: string,
  wordCount: number,
  essayPrompt?: string | null,
): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO essays (id, session_id, filename, pdf_path, pdf_content, word_count, essay_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, filename, pdfPath, pdfContent, wordCount, essayPrompt ?? null);
  return id;
}

/** An essay with its current topic. */
const ESSAY_SELECT = `
  SELECT e.*, ct.topic_id
  FROM essays e LEFT JOIN essay_current_topics ct ON ct.essay_id = e.id`;

export function getEssay(essayId: string): Essay | null {
  return (getDb().prepare(`${ESSAY_SELECT} WHERE e.id = ?`).get(essayId) as Essay) ?? null;
}

export function getEssaysBySession(sessionId: string): Essay[] {
  return getDb().prepare(`${ESSAY_SELECT} WHERE e.session_id = ? ORDER BY e.filename`).all(sessionId) as Essay[];
}

/** Essays of a session as EssayMeta, ordered by filename. */
export function listEssayMetas(sessionId: string): EssayMeta[] {
  return getEssaysBySession(sessionId).map((e) => ({
    id: e.id,
    filename: e.filename,
    content: e.pdf_content,
    prompt: e.essay_prompt,
    wordCount: e.word_count,
    gradingStatus: e.grading_status,
    overallGrade: e.overall_grade,
    avgAiScore: e.avg_ai_score,
    summary: e.summary,
    topicId: e.topic_id,
  }));
}

export function updateEssayFlag(essayId: string, flagged: boolean): void {
  getDb().prepare('UPDATE essays SET is_flagged = ? WHERE id = ?').run(flagged ? 1 : 0, essayId);
}

export function updateEssayGrade(essayId: string, status: string, overallGrade?: number): void {
  getDb().prepare('UPDATE essays SET grading_status = ?, overall_grade = ? WHERE id = ?')
    .run(status, overallGrade ?? null, essayId);
}

/** Moves an essay from 'pending' to 'grading' (never back from 'graded'). */
export function markEssayInProgress(sessionId: string, essayId: string): void {
  getDb().prepare(`
    UPDATE essays SET grading_status = 'grading'
    WHERE id = ? AND session_id = ? AND grading_status != 'graded'
  `).run(essayId, sessionId);
}

export function updateEssaySummary(essayId: string, summary: string): void {
  getDb().prepare('UPDATE essays SET summary = ? WHERE id = ?').run(summary, essayId);
}

/** Recomputes essays.avg_ai_score from the essay's AI grades. */
export function updateEssayAiQuality(essayId: string, sessionId: string): void {
  getDb().prepare(`
    UPDATE essays SET avg_ai_score = (
      SELECT AVG(ai_score) FROM grades WHERE session_id = ? AND essay_id = ? AND ai_score IS NOT NULL
    ) WHERE id = ?
  `).run(sessionId, essayId, essayId);
}

/** Essays ranked by average AI score; ties share a rank, unscored essays come last. */
export function computeQualityRanks(sessionId: string): QualityRank[] {
  const rows = getDb().prepare(
    'SELECT id, avg_ai_score FROM essays WHERE session_id = ? ORDER BY avg_ai_score DESC NULLS LAST'
  ).all(sessionId) as { id: string; avg_ai_score: number | null }[];

  const result: QualityRank[] = [];
  let rank = 1;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i].avg_ai_score !== rows[i - 1].avg_ai_score) {
      rank = i + 1;
    }
    result.push({ essayId: rows[i].id, avgAiScore: rows[i].avg_ai_score, rank });
  }
  return result;
}
