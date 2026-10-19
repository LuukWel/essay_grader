import { randomUUID } from 'crypto';
import type { EssayMeta } from '@/types';
import { getDb } from './client';

export interface Essay {
  id: string;
  session_id: string;
  dataset_essay_id: string;
  /** Display label, derived as "essay-<dataset id>" for the UI and exports. */
  filename: string;
  source_path: string;
  essay_prompt: string | null;
  /** The essay text. */
  essay_text: string;
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

/** The original CSV `id`, scoped to its imported session. */
export function datasetId(essay: Pick<Essay, 'dataset_essay_id'>): string {
  return essay.dataset_essay_id;
}

export interface QualityRank {
  essayId: string;
  avgAiScore: number | null;
  rank: number;
}

export function createEssay(
  sessionId: string,
  datasetEssayId: string,
  sourcePath: string,
  essayText: string,
  wordCount: number,
  essayPrompt?: string | null,
): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO essays (id, session_id, dataset_essay_id, source_path, essay_text, word_count, essay_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId, datasetEssayId, sourcePath, essayText, wordCount, essayPrompt ?? null);
  return id;
}

/** An essay with its current topic and averages calculated from saved grades. */
const ESSAY_SELECT = `
  SELECT e.*, 'essay-' || e.dataset_essay_id AS filename, ct.topic_id, s.overall_grade, s.avg_ai_score
  FROM essays e
  LEFT JOIN essay_current_topics ct ON ct.essay_id = e.id
  JOIN essay_scores s ON s.essay_id = e.id`;

export function getEssay(essayId: string): Essay | null {
  return (getDb().prepare(`${ESSAY_SELECT} WHERE e.id = ?`).get(essayId) as Essay) ?? null;
}

export function getEssaysBySession(sessionId: string): Essay[] {
  return getDb().prepare(`${ESSAY_SELECT} WHERE e.session_id = ? ORDER BY e.dataset_essay_id`).all(sessionId) as Essay[];
}

/** Essays of a session as EssayMeta, ordered by filename. */
export function listEssayMetas(sessionId: string): EssayMeta[] {
  return getEssaysBySession(sessionId).map((e) => ({
    id: e.id,
    filename: e.filename,
    content: e.essay_text,
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

export function updateEssayGrade(essayId: string, status: string): void {
  getDb().prepare('UPDATE essays SET grading_status = ? WHERE id = ?').run(status, essayId);
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

/** Essays ranked by average AI score; ties share a rank, unscored essays come last. */
export function computeQualityRanks(sessionId: string): QualityRank[] {
  const rows = getDb().prepare(
    `SELECT e.id, s.avg_ai_score FROM essays e JOIN essay_scores s ON s.essay_id = e.id
     WHERE e.session_id = ? ORDER BY s.avg_ai_score DESC NULLS LAST`
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
