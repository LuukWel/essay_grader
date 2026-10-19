// Data access queries in src/server/db/.

import { beforeAll, describe, expect, it } from 'vitest';
import { getActionLogs, logAction, parseActionDetail } from '@/server/db/action-logs';
import { getBenchmarks, setBenchmark } from '@/server/db/benchmarks';
import { getEssaysBySession, updateEssayGrade, updateEssaySummary } from '@/server/db/essays';
import { createTeacherHighlight, deleteTeacherHighlight, getTeacherHighlights } from '@/server/db/highlights';
import { getSessionProgress, getSessionStats } from '@/server/db/sessions';
import { createSessionWithEssays } from '@/server/services/session-service';
import { TEST_RUBRIC } from '../helpers';

let sessionId: string;
let essayIds: string[];

beforeAll(() => {
  sessionId = createSessionWithEssays(
    {
      participantId: 'P01', condition: 'baseline', essaySet: 'TEST', usePrecomputedTopics: false,
      precomputedK: null, precomputeGrades: false, useCachedAssessments: false,
      assessmentType: 'flow', assessmentLength: 'medium',
    },
    { csvText: 'id,essay\nA,First essay.\nB,Second essay.\nC,Third essay.\n', csvPath: 'test.csv', rubric: TEST_RUBRIC },
  );
  essayIds = getEssaysBySession(sessionId).map((e) => e.id);
});

describe('session statistics and progress', () => {
  it('counts graded essays and averages their grades', () => {
    expect(getSessionStats(sessionId)).toEqual({ totalEssays: 3, gradedEssays: 0, avgGrade: null, gradeDistribution: {} });

    updateEssayGrade(essayIds[0], 'graded', 4);
    updateEssayGrade(essayIds[1], 'graded', 3);
    expect(getSessionStats(sessionId)).toEqual({
      totalEssays: 3, gradedEssays: 2, avgGrade: 3.5, gradeDistribution: { 6: 1, 8: 1 },
    });
  });

  it('reports pipeline progress from the stored results', () => {
    updateEssaySummary(essayIds[2], 'A summary.');
    expect(getSessionProgress(sessionId)).toEqual({ total: 3, summarised: 1, topics: 0, similarities: 0 });
  });
});

describe('benchmarks', () => {
  it('returns each benchmark with its essay filename and summary', () => {
    setBenchmark(sessionId, 1, 4, essayIds[2], {});
    expect(getBenchmarks(sessionId, 1)).toMatchObject([
      { essay_id: essayIds[2], benchmark_type: '4', score: 4, filename: 'essay-C', summary: 'A summary.' },
    ]);
  });
});

describe('research log', () => {
  it('stores the detail as JSON once', () => {
    logAction(sessionId, 'P01', 'baseline', 'TEST', 'essay_opened', essayIds[0], { criterion: 'Content' });
    const row = getActionLogs({ sessionId }).find((l) => l.action_type === 'essay_opened')!;
    expect(row.action_detail).toBe('{"criterion":"Content"}');
    expect(parseActionDetail(row.action_detail)).toEqual({ criterion: 'Content' });
  });

  it('decodes details stored as a JSON string holding JSON', () => {
    expect(parseActionDetail(JSON.stringify(JSON.stringify({ visible: true })))).toEqual({ visible: true });
    expect(parseActionDetail('"plain text"')).toBe('plain text');
    expect(parseActionDetail('not json')).toBe('not json');
    expect(parseActionDetail(null)).toBeNull();
  });
});

describe('teacher highlights', () => {
  it('deletes only a highlight of the given session and returns it', () => {
    const id = createTeacherHighlight(sessionId, essayIds[0], 1, 0, 5, 'First');
    expect(deleteTeacherHighlight('other-session', id)).toBeNull();
    expect(deleteTeacherHighlight(sessionId, id)).toMatchObject({ id, text: 'First' });
    expect(getTeacherHighlights(sessionId, essayIds[0])).toEqual([]);
    expect(deleteTeacherHighlight(sessionId, id)).toBeNull();
  });
});
