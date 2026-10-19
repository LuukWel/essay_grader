// Saving grades through the data access layer, on the app's (in-memory) database.

import { beforeAll, describe, expect, it } from 'vitest';
import { getEssaysBySession } from '@/server/db/essays';
import { getGrades, upsertGrade } from '@/server/db/grades';
import { getDb } from '@/server/db/client';
import { RUBRIC_CRITERIA } from '@/lib/llm-config';
import { saveGrade } from '@/server/services/grading-service';
import { createSessionWithEssays } from '@/server/services/session-service';
import { TEST_RUBRIC } from '../helpers';

let sessionId: string;
let essayId: string;

beforeAll(() => {
  sessionId = createSessionWithEssays(
    {
      participantId: 'P01', condition: 'baseline', essaySet: 'TEST', usePrecomputedTopics: false,
      precomputedK: null, precomputeGrades: false, useCachedAssessments: false,
      assessmentType: 'flow', assessmentLength: 'medium',
    },
    { csvText: 'id,essay\nA,First essay.\n', csvPath: 'test.csv', rubric: TEST_RUBRIC },
  );
  essayId = getEssaysBySession(sessionId)[0].id;
});

describe('upsertGrade', () => {
  it('inserts once and updates in place, keeping fields that were not sent', () => {
    upsertGrade(sessionId, essayId, 1, { ai_score: 3, ai_justification: 'AI says 3' });
    upsertGrade(sessionId, essayId, 1, { teacher_score: 4 });
    upsertGrade(sessionId, essayId, 1, { teacher_justification: 'Good argument' });

    const grades = getGrades(sessionId, essayId);
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({
      teacher_score: 4,
      teacher_justification: 'Good argument',
      ai_score: 3,
      ai_justification: 'AI says 3',
      original_ai_score: 3,
    });
  });

  it('clears a field only when null is sent explicitly', () => {
    upsertGrade(sessionId, essayId, 1, { teacher_score: null });
    expect(getGrades(sessionId, essayId)[0]).toMatchObject({ teacher_score: null, ai_score: 3 });
  });

  it('lets the database reject an out-of-range score', () => {
    expect(() => upsertGrade(sessionId, essayId, 3, { teacher_score: 9 })).toThrow('score outside criterion range');
    expect(getGrades(sessionId, essayId)).toHaveLength(1);
  });
});

describe('saveGrade (grading service)', () => {
  const organization = RUBRIC_CRITERIA.find((c) => c.name === 'Organization')!;
  const rankLogs = () => (getDb().prepare(
    "SELECT COUNT(*) AS n FROM action_logs WHERE session_id = ? AND action_type = 'quality_rank_updated'"
  ).get(sessionId) as { n: number }).n;

  it('returns the stored grade and updates what is derived from it', () => {
    const before = rankLogs();
    const grade = saveGrade(sessionId, { essayId, criterion: organization, fields: { teacher_score: 2, ai_score: 4 } });

    expect(grade).toMatchObject({ criterion_name: 'Organization', teacher_score: 2, ai_score: 4 });
    const essay = getEssaysBySession(sessionId)[0];
    expect(essay.grading_status).toBe('grading');
    expect(essay.avg_ai_score).toBe(3.5); // Content AI 3, Organization AI 4
    expect(rankLogs()).toBe(before + 1);
  });

  it('stores nothing when a later step fails', () => {
    // If the rank snapshot fails, the grade must be rolled back too.
    getDb().exec(`
      CREATE TEMP TRIGGER fail_rank_log BEFORE INSERT ON action_logs
      BEGIN SELECT RAISE(ABORT, 'simulated log failure'); END;
    `);
    try {
      expect(() => saveGrade(sessionId, { essayId, criterion: organization, fields: { ai_score: 1 } }))
        .toThrow('simulated log failure');
      expect(getGrades(sessionId, essayId).find((g) => g.criterion_name === 'Organization')?.ai_score).toBe(4);
      expect(getEssaysBySession(sessionId)[0].avg_ai_score).toBe(3.5);
    } finally {
      getDb().exec('DROP TRIGGER fail_rank_log');
    }
  });

  it('refreshes averages and rank history when an AI score is cleared', () => {
    const before = rankLogs();
    saveGrade(sessionId, { essayId, criterion: organization, fields: { ai_score: null } });
    expect(getEssaysBySession(sessionId)[0].avg_ai_score).toBe(3);
    expect(rankLogs()).toBe(before + 1);
    expect(getGrades(sessionId, essayId).find((g) => g.criterion_name === 'Organization'))
      .toMatchObject({ ai_score: null, original_ai_score: 4, teacher_score: 2 });
  });
});
