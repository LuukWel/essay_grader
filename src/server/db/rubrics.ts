// Rubric storage. A stored rubric is immutable; sessions reference the version they use.

import type { Criterion } from '@/types';
import { getDb } from './client';

export interface RubricDefinition {
  id: string;
  /** The rubric text shown to the teacher and sent to the model. */
  sourceText: string;
  criteria: Criterion[];
}

export class RubricConflictError extends Error {
  constructor(rubricId: string) {
    super(`Rubric "${rubricId}" is already stored with different criteria or text. `
      + 'A stored rubric cannot change: give the changed rubric a new id (RUBRIC_ID in src/lib/llm-config.ts).');
    this.name = 'RubricConflictError';
  }
}

interface CriterionRow { criterion_id: number; name: string; min_score: number; max_score: number }
interface LevelRow { criterion_id: number; score: number; description: string }

function toCriteria(criteria: CriterionRow[], levels: LevelRow[]): Criterion[] {
  return criteria.map((c) => ({
    id: c.criterion_id,
    name: c.name,
    scoreRange: { min: c.min_score, max: c.max_score },
    levels: levels
      .filter((l) => l.criterion_id === c.criterion_id)
      .map((l) => ({ score: l.score, description: l.description })),
  }));
}

/** Criteria of a rubric in grading order, or [] for an unknown rubric. */
export function getRubricCriteria(rubricId: string): Criterion[] {
  const db = getDb();
  const criteria = db.prepare(`
    SELECT criterion_id, name, min_score, max_score FROM rubric_criteria
    WHERE rubric_id = ? ORDER BY position
  `).all(rubricId) as CriterionRow[];
  const levels = db.prepare(`
    SELECT criterion_id, score, description FROM rubric_levels
    WHERE rubric_id = ? ORDER BY criterion_id, score
  `).all(rubricId) as LevelRow[];
  return toCriteria(criteria, levels);
}

/** Criteria of the rubric a session is graded with, or [] for an unknown session. */
export function getSessionCriteria(sessionId: string): Criterion[] {
  const row = getDb().prepare('SELECT rubric_id FROM sessions WHERE id = ?').get(sessionId) as
    | { rubric_id: string }
    | undefined;
  return row ? getRubricCriteria(row.rubric_id) : [];
}

const comparable = (criteria: Criterion[]) => JSON.stringify(criteria.map((c) => ({
  id: c.id, name: c.name, min: c.scoreRange.min, max: c.scoreRange.max,
  levels: [...c.levels].sort((a, b) => a.score - b.score).map((l) => [l.score, l.description]),
})));

/** Stores the rubric if the id is new. Throws RubricConflictError if the id exists with other content. */
export function ensureRubric(rubric: RubricDefinition): void {
  const db = getDb();
  const stored = db.prepare('SELECT source_text FROM rubrics WHERE id = ?').get(rubric.id) as
    | { source_text: string }
    | undefined;

  if (stored) {
    const same = stored.source_text === rubric.sourceText
      && comparable(getRubricCriteria(rubric.id)) === comparable(rubric.criteria);
    if (!same) throw new RubricConflictError(rubric.id);
    return;
  }

  const insertCriterion = db.prepare(`
    INSERT INTO rubric_criteria (rubric_id, criterion_id, name, position, min_score, max_score)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertLevel = db.prepare(
    'INSERT INTO rubric_levels (rubric_id, criterion_id, score, description) VALUES (?, ?, ?, ?)'
  );
  db.transaction(() => {
    db.prepare('INSERT INTO rubrics (id, source_text) VALUES (?, ?)').run(rubric.id, rubric.sourceText);
    rubric.criteria.forEach((c, i) => {
      insertCriterion.run(rubric.id, c.id, c.name, i + 1, c.scoreRange.min, c.scoreRange.max);
      for (const level of c.levels) insertLevel.run(rubric.id, c.id, level.score, level.description);
    });
  })();
}
