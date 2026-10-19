// AI grade precompute with a fake model: identity-based reuse, validation, partial runs
// and retries.

import { describe, expect, it } from 'vitest';
import { RUBRIC_CRITERIA } from '@/lib/llm-config';
import { contentHash } from '@/lib/cache-key';
import { getDb } from '@/server/db/client';
import { getEssaysBySession } from '@/server/db/essays';
import { getGrades, upsertGrade } from '@/server/db/grades';
import { getLatestRun } from '@/server/db/pipeline-runs';
import { getSession } from '@/server/db/sessions';
import { INSTANCE_ID } from '@/server/instance';
import { startGradingPrecompute, type GradeInput, type PrecomputeDeps } from '@/server/services/grading-precompute';
import { createTestSession } from '../helpers';

const ESSAYS = { A: 'Phones distract students.', B: 'Uniforms limit self-expression.' };
const CRITERIA = RUBRIC_CRITERIA.length; // 3

function fakeDeps(overrides: Partial<PrecomputeDeps> & { reply?: (input: GradeInput) => unknown } = {}) {
  const calls: string[] = [];
  const { reply, ...rest } = overrides;
  const deps: PrecomputeDeps = {
    model: 'fake-grader',
    timeoutMs: 1000,
    criteria: RUBRIC_CRITERIA,
    async grade(input) {
      calls.push(`${input.essayContent.slice(0, 6)}/${input.criterion.name}`);
      return reply ? reply(input) : { score: 3, justification: 'Plain reasons.', evidence: [{ quote: 'Phones' }] };
    },
    ...rest,
  };
  return { deps, calls };
}

async function precompute(sessionId: string, deps: PrecomputeDeps) {
  const start = startGradingPrecompute(sessionId, deps);
  if (start.status !== 'started') throw new Error(`expected a new run, got ${start.status}`);
  await start.finished;
  return getLatestRun(sessionId, 'grading_precompute', INSTANCE_ID)!;
}

const storedStatuses = () =>
  (getDb().prepare('SELECT status, COUNT(*) AS n FROM ai_assessments GROUP BY status').all() as { status: string; n: number }[]);

describe('grading precompute', () => {
  it('grades every essay and criterion and marks the session precomputed', async () => {
    const sessionId = createTestSession(ESSAYS);
    const run = await precompute(sessionId, fakeDeps().deps);

    expect(run).toMatchObject({ status: 'success', expected_items: 2 * CRITERIA, processed_items: 2 * CRITERIA, failed_items: 0 });
    expect(getSession(sessionId)!.grades_precomputed).toBe(1);
    const essay = getEssaysBySession(sessionId)[0];
    expect(getGrades(sessionId, essay.id)).toHaveLength(CRITERIA);
    expect(getGrades(sessionId, essay.id)[0]).toMatchObject({ ai_score: 3, original_ai_score: 3, ai_justification: 'Plain reasons.' });
    expect(essay.avg_ai_score).toBe(3);
  });

  it('keeps the teacher\'s fields when it adds the AI score', async () => {
    const sessionId = createTestSession(ESSAYS);
    const essay = getEssaysBySession(sessionId)[0];
    upsertGrade(sessionId, essay.id, 1, { teacher_score: 5, teacher_justification: 'Excellent.' });

    await precompute(sessionId, fakeDeps().deps);

    expect(getGrades(sessionId, essay.id).find((g) => g.criterion_name === 'Content'))
      .toMatchObject({ teacher_score: 5, teacher_justification: 'Excellent.', ai_score: 3 });
  });

  it('reuses stored assessments for the same essays, criteria, model and prompt', async () => {
    await precompute(createTestSession(ESSAYS), fakeDeps().deps);
    const { deps, calls } = fakeDeps();

    await precompute(createTestSession(ESSAYS), deps);

    expect(calls).toEqual([]);
  });

  it('asks the model again when the session does not allow reuse, or the model changed', async () => {
    await precompute(createTestSession(ESSAYS), fakeDeps().deps);

    const noReuse = fakeDeps();
    await precompute(createTestSession(ESSAYS, { useCachedAssessments: false }), noReuse.deps);
    expect(noReuse.calls).toHaveLength(2 * CRITERIA);

    const otherModel = fakeDeps({ model: 'other-grader' });
    await precompute(createTestSession(ESSAYS), otherModel.deps);
    expect(otherModel.calls).toHaveLength(2 * CRITERIA);
  });

  it('counts invalid model output as a failure, records why, and retries it on the next run', async () => {
    const sessionId = createTestSession({ Q: 'Questionable essay text.' });
    const bad = fakeDeps({
      reply: (input) => (input.criterion.name === 'Language'
        ? { score: 9, justification: 'Off the scale.' }
        : { score: 2, justification: 'Weak.' }),
    });

    const first = await precompute(sessionId, bad.deps);
    expect(first).toMatchObject({ status: 'partial', processed_items: 2, failed_items: 1 });
    expect(first.error_message).toContain('Language: score 9 is not an integer from 1 to 5');
    expect(getSession(sessionId)!.grades_precomputed).toBe(0);
    expect(storedStatuses().find((s) => s.status === 'failed')?.n).toBeGreaterThanOrEqual(1);

    // Failures aren't reused: the next run retries that item only.
    const { deps, calls } = fakeDeps();
    const retry = await precompute(sessionId, deps);
    expect(calls).toEqual(['Questi/Language']);
    expect(retry.status).toBe('success');
    expect(getSession(sessionId)!.grades_precomputed).toBe(1);
    const language = getDb().prepare(
      'SELECT status, attempts, error FROM ai_assessments WHERE content_hash = ? AND criterion_id = 3'
    ).get(contentHash('Questionable essay text.'));
    expect(language).toEqual({ status: 'success', attempts: 2, error: null });
  });

  it('gives up on an item that does not answer in time', async () => {
    const sessionId = createTestSession({ S: 'Slow essay.' });
    const { deps } = fakeDeps({
      timeoutMs: 50,
      criteria: [RUBRIC_CRITERIA[0]],
      grade: (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    });

    const run = await precompute(sessionId, deps);

    expect(run).toMatchObject({ status: 'failed', processed_items: 0, failed_items: 1 });
    expect(run.error_message).toContain('no reply within 0.05s');
  });
});
