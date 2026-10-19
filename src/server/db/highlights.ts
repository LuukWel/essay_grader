import { getDb } from './client';

export interface TeacherHighlight {
  id: number;
  session_id: string;
  essay_id: string;
  rubric_id: string;
  criterion_id: number;
  /** From rubric_criteria. */
  criterion_name: string;
  /** Character offsets into the essay text: text = essay.slice(start_index, end_index). */
  start_index: number;
  end_index: number;
  text: string;
  created_at: string;
}

const HIGHLIGHT_SELECT = `
  SELECT h.*, rc.name AS criterion_name
  FROM teacher_highlights h JOIN rubric_criteria rc USING (rubric_id, criterion_id)`;

export function createTeacherHighlight(
  sessionId: string,
  essayId: string,
  criterionId: number,
  startIndex: number,
  endIndex: number,
  text: string,
): number {
  const result = getDb().prepare(`
    INSERT INTO teacher_highlights (session_id, essay_id, rubric_id, criterion_id, start_index, end_index, text)
    SELECT s.id, ?, s.rubric_id, ?, ?, ?, ? FROM sessions s WHERE s.id = ?
  `).run(essayId, criterionId, startIndex, endIndex, text, sessionId);
  if (result.changes === 0) throw new Error(`Session ${sessionId} not found`);
  return result.lastInsertRowid as number;
}

export function getTeacherHighlights(sessionId: string, essayId: string): TeacherHighlight[] {
  return getDb().prepare(`${HIGHLIGHT_SELECT} WHERE h.session_id = ? AND h.essay_id = ? ORDER BY h.start_index`)
    .all(sessionId, essayId) as TeacherHighlight[];
}

export function getTeacherHighlightsBySession(sessionId: string): TeacherHighlight[] {
  return getDb().prepare(`${HIGHLIGHT_SELECT} WHERE h.session_id = ? ORDER BY h.essay_id, h.start_index`)
    .all(sessionId) as TeacherHighlight[];
}

/** Deletes a highlight of this session; returns it, or null when there was none. */
export function deleteTeacherHighlight(sessionId: string, highlightId: number): TeacherHighlight | null {
  const db = getDb();
  return db.transaction(() => {
    const highlight = db.prepare(`${HIGHLIGHT_SELECT} WHERE h.id = ? AND h.session_id = ?`)
      .get(highlightId, sessionId) as TeacherHighlight | undefined;
    if (!highlight) return null;
    db.prepare('DELETE FROM teacher_highlights WHERE id = ?').run(highlightId);
    return highlight;
  })();
}
