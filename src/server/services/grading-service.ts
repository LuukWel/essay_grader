// Saves a grade from the grading screen. In the same transaction it marks the essay as in
// progress (when a teacher score is set) and logs a rank snapshot when an AI score changes.
// Averages are read from essay_scores. Input is validated in validation/grade.ts.

import { logAction } from '@/server/db/action-logs';
import { getDb } from '@/server/db/client';
import { computeQualityRanks, markEssayInProgress } from '@/server/db/essays';
import { getGradeForCriterion, upsertGrade, type Grade } from '@/server/db/grades';
import { getSession } from '@/server/db/sessions';
import type { GradeUpdate } from '@/server/validation/grade';

/** Stores the update and returns the grade as it is now stored. */
export function saveGrade(sessionId: string, update: GradeUpdate): Grade {
  const { essayId, criterion, fields } = update;

  return getDb().transaction(() => {
    upsertGrade(sessionId, essayId, criterion.id, fields);

    // 'graded' is set when the essay is finished; a score only means it's in progress.
    if (fields.teacher_score != null) {
      markEssayInProgress(sessionId, essayId);
    }

    if (fields.ai_score !== undefined) {
      const session = getSession(sessionId);
      if (session) {
        logAction(sessionId, session.participant_id, session.condition, session.essay_set,
          'quality_rank_updated', undefined, computeQualityRanks(sessionId));
      }
    }

    return getGradeForCriterion(sessionId, essayId, criterion.id)!;
  })();
}
