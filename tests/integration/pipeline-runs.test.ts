import { describe, expect, it } from 'vitest';
import { finishRun, getLatestRun, recordRunItem, startRun, type NewRun } from '@/server/db/pipeline-runs';
import { createTestSession } from '../helpers';

const newRun = (sessionId: string, instanceId = 'this-process'): NewRun => ({
  sessionId, type: 'grading_precompute', instanceId, inputHash: 'h', config: { model: 'm' }, expectedItems: 3,
});

describe('pipeline runs', () => {
  it('allows one running run per session and pipeline', () => {
    const sessionId = createTestSession({ A: 'Essay.' });
    const first = startRun(newRun(sessionId));
    expect('started' in first).toBe(true);

    const second = startRun(newRun(sessionId));
    expect(second).toMatchObject({ alreadyRunning: { status: 'running' } });
  });

  it('marks a run of a previous server process as interrupted and starts a new one', () => {
    const sessionId = createTestSession({ A: 'Essay.' });
    startRun(newRun(sessionId, 'old-process'));

    const restarted = startRun(newRun(sessionId, 'new-process'));

    expect('started' in restarted).toBe(true);
    const runs = getLatestRun(sessionId, 'grading_precompute', 'new-process');
    expect(runs?.status).toBe('running');
    expect(getLatestRun(sessionId, 'grading_precompute', 'another-restart')).toMatchObject({
      status: 'interrupted',
      error_message: 'The server stopped while this run was in progress',
    });
  });

  it('counts items and records how the run ended', () => {
    const sessionId = createTestSession({ A: 'Essay.' });
    const start = startRun(newRun(sessionId));
    if (!('started' in start)) throw new Error('expected a new run');
    const id = start.started.id;

    recordRunItem(id, 'processed');
    recordRunItem(id, 'processed');
    recordRunItem(id, 'failed');
    finishRun(id, 'partial', '1 failed');

    expect(getLatestRun(sessionId, 'grading_precompute', 'this-process')).toMatchObject({
      status: 'partial', processed_items: 2, failed_items: 1, error_message: '1 failed',
    });
    expect(getLatestRun(sessionId, 'grading_precompute', 'this-process')!.finished_at).not.toBeNull();
  });
});
