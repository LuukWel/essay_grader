// Session creation. The whole CSV is validated first; rubric, session and essays are then
// written in one transaction, so a failure leaves nothing behind.

import { getDb } from '@/server/db/client';
import { createEssay } from '@/server/db/essays';
import { ensureRubric, type RubricDefinition } from '@/server/db/rubrics';
import { createSession } from '@/server/db/sessions';
import { DEFAULT_TOPIC_K } from '@/server/services/topic-model';
import { parseEssayCsv } from '@/server/validation/essay-import';
import type { SessionInput } from '@/server/validation/session';

/** The essay set or the chosen options are invalid; `errors` lists every problem found. */
export class ImportError extends Error {
  constructor(readonly errors: string[]) {
    const shown = errors.slice(0, 5).join('; ');
    const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : '';
    super(`Essay set is invalid: ${shown}${more}`);
    this.name = 'ImportError';
  }
}

export interface EssaySource {
  csvText: string;
  /** Stored with each essay for reference. */
  csvPath: string;
  /** The rubric the session is graded with. */
  rubric: RubricDefinition;
}

/**
 * Creates a session with its essays. Throws ImportError for an invalid CSV or options and
 * RubricConflictError for a changed rubric; nothing is written in either case.
 */
export function createSessionWithEssays(input: SessionInput, source: EssaySource): string {
  const parsed = parseEssayCsv(source.csvText);
  if (!parsed.ok) throw new ImportError(parsed.errors);

  if (input.condition === 'dashboard') {
    const k = input.precomputedK ?? DEFAULT_TOPIC_K;
    if (k > parsed.rows.length) {
      throw new ImportError([`${k} topics need at least ${k} essays; this set has ${parsed.rows.length}`]);
    }
  }

  const insertAll = getDb().transaction(() => {
    ensureRubric(source.rubric);
    const sessionId = createSession(
      input.participantId, input.condition, input.essaySet, source.rubric.id,
      input.usePrecomputedTopics, input.precomputedK, input.precomputeGrades,
      input.useCachedAssessments, input.assessmentType, input.assessmentLength,
    );
    for (const row of parsed.rows) {
      createEssay(sessionId, row.sourceId, source.csvPath, row.essay, row.wordCount, row.prompt);
    }
    return sessionId;
  });

  return insertAll();
}
