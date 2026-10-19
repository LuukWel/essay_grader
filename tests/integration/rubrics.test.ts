// Rubric storage: stored once, immutable, and each session keeps its own version.

import { describe, expect, it } from 'vitest';
import { RUBRIC_CRITERIA } from '@/lib/llm-config';
import { getDb } from '@/server/db/client';
import { getEssaysBySession } from '@/server/db/essays';
import { getGrades, upsertGrade } from '@/server/db/grades';
import { RubricConflictError, ensureRubric, getRubricCriteria, getSessionCriteria } from '@/server/db/rubrics';
import { getSession } from '@/server/db/sessions';
import { createSessionWithEssays } from '@/server/services/session-service';
import type { SessionInput } from '@/server/validation/session';
import { TEST_RUBRIC, createTestSession } from '../helpers';

const count = (sql: string) => (getDb().prepare(sql).get() as { n: number }).n;

const input: SessionInput = {
  participantId: 'P-rubric', condition: 'baseline', essaySet: 'TEST', usePrecomputedTopics: false,
  precomputedK: null, precomputeGrades: false, useCachedAssessments: false, assessmentType: 'flow', assessmentLength: 'medium',
};
const csv = { csvText: 'id,essay\nA,An essay.\n', csvPath: 'test.csv' };

describe('rubrics', () => {
  it('stores the rubric with the first session and reuses it for later ones', () => {
    const first = createTestSession({ A: 'One.' });
    const second = createTestSession({ A: 'Two.' });

    expect(count(`SELECT COUNT(*) AS n FROM rubrics WHERE id = '${TEST_RUBRIC.id}'`)).toBe(1);
    expect(getSession(first)!.rubric_id).toBe(TEST_RUBRIC.id);
    expect(getSession(second)!.rubric_content).toBe('Rubric');
    expect(getSessionCriteria(first)).toEqual(RUBRIC_CRITERIA);
  });

  it('refuses a changed rubric under a stored id and writes nothing', () => {
    createTestSession({ A: 'Stored first.' });
    const sessions = count('SELECT COUNT(*) AS n FROM sessions');
    const renamed = RUBRIC_CRITERIA.map((c, i) => (i === 0 ? { ...c, name: 'Argument' } : c));

    expect(() => createSessionWithEssays(input, { ...csv, rubric: { ...TEST_RUBRIC, criteria: renamed } }))
      .toThrow(RubricConflictError);
    expect(() => ensureRubric({ ...TEST_RUBRIC, sourceText: 'Edited rubric' })).toThrow(RubricConflictError);
    expect(count('SELECT COUNT(*) AS n FROM sessions')).toBe(sessions);
    expect(getRubricCriteria(TEST_RUBRIC.id)[0].name).toBe('Content');
  });

  it('keeps each session on its own rubric version', () => {
    const v1 = createTestSession({ A: 'Old rubric.' });
    const v2Criteria = [{ id: 4, name: 'Argument', scoreRange: { min: 1, max: 5 }, levels: [{ score: 1, description: 'Weak' }] }];
    const v2 = createSessionWithEssays(
      { ...input, participantId: 'P-v2' },
      { ...csv, rubric: { id: 'essay-v2', sourceText: 'Argument only', criteria: v2Criteria } },
    );

    expect(getSessionCriteria(v1).map((c) => c.name)).toEqual(['Content', 'Organization', 'Language']);
    expect(getSessionCriteria(v2)).toEqual(v2Criteria);

    // A grade can only use a criterion of the session's own rubric.
    const essay = getEssaysBySession(v2)[0];
    expect(() => upsertGrade(v2, essay.id, 1, { teacher_score: 3 })).toThrow('FOREIGN KEY constraint failed');
    upsertGrade(v2, essay.id, 4, { teacher_score: 3 });
    expect(getGrades(v2, essay.id)).toMatchObject([{ rubric_id: 'essay-v2', criterion_id: 4, criterion_name: 'Argument' }]);
  });
});
