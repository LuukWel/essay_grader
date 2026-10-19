import { RUBRIC_CRITERIA, RUBRIC_ID } from '@/lib/llm-config';
import type { RubricDefinition } from '@/server/db/rubrics';
import type { SessionInput } from '@/server/validation/session';
import { createSessionWithEssays } from '@/server/services/session-service';

/** The app's rubric with a short text; every test session uses it. */
export const TEST_RUBRIC: RubricDefinition = { id: RUBRIC_ID, sourceText: 'Rubric', criteria: RUBRIC_CRITERIA };

/** Creates a session with the given essays (dataset ID -> text) in the test database. */
export function createTestSession(
  essays: Record<string, string>,
  options: Partial<SessionInput> = {},
): string {
  const csv = ['id,essay', ...Object.entries(essays).map(([id, text]) => `${id},"${text.replace(/"/g, '""')}"`)].join('\n');
  return createSessionWithEssays(
    {
      participantId: 'P01',
      condition: 'baseline',
      essaySet: 'TEST',
      usePrecomputedTopics: false,
      precomputedK: 2,
      precomputeGrades: true,
      useCachedAssessments: true,
      assessmentType: 'flow',
      assessmentLength: 'medium',
      ...options,
    },
    { csvText: csv, csvPath: 'test.csv', rubric: TEST_RUBRIC },
  );
}
