// Records of background pipeline runs (cohort processing, AI grading precompute).

import { getDb } from './client';

export type PipelineType = 'cohort_processing' | 'grading_precompute';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'interrupted';

export interface PipelineRun {
  id: number;
  session_id: string;
  pipeline_type: PipelineType;
  status: RunStatus;
  instance_id: string;
  input_hash: string;
  config_json: string;
  expected_items: number;
  processed_items: number;
  failed_items: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface NewRun {
  sessionId: string;
  type: PipelineType;
  instanceId: string;
  inputHash: string;
  config: Record<string, unknown>;
  expectedItems: number;
}

/** A run left 'running' by an earlier server process will never finish; mark it interrupted. */
function closeInterruptedRuns(sessionId: string, type: PipelineType, instanceId: string): void {
  getDb().prepare(`
    UPDATE pipeline_runs
    SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP,
        error_message = 'The server stopped while this run was in progress'
    WHERE session_id = ? AND pipeline_type = ? AND status = 'running' AND instance_id <> ?
  `).run(sessionId, type, instanceId);
}

/** Starts a run, or returns the run that is already in progress for this session and pipeline. */
export function startRun(run: NewRun): { started: PipelineRun } | { alreadyRunning: PipelineRun } {
  const db = getDb();
  return db.transaction(() => {
    closeInterruptedRuns(run.sessionId, run.type, run.instanceId);
    const running = db.prepare(
      "SELECT * FROM pipeline_runs WHERE session_id = ? AND pipeline_type = ? AND status = 'running'"
    ).get(run.sessionId, run.type) as PipelineRun | undefined;
    if (running) return { alreadyRunning: running };

    const started = db.prepare(`
      INSERT INTO pipeline_runs (session_id, pipeline_type, status, instance_id, input_hash, config_json, expected_items)
      VALUES (?, ?, 'running', ?, ?, ?, ?)
      RETURNING *
    `).get(run.sessionId, run.type, run.instanceId, run.inputHash, JSON.stringify(run.config), run.expectedItems) as PipelineRun;
    return { started };
  })();
}

/** Counts one finished item of a run. */
export function recordRunItem(runId: number, outcome: 'processed' | 'failed'): void {
  const column = outcome === 'processed' ? 'processed_items' : 'failed_items';
  getDb().prepare(`UPDATE pipeline_runs SET ${column} = ${column} + 1 WHERE id = ?`).run(runId);
}

export function finishRun(runId: number, status: Exclude<RunStatus, 'running'>, errorMessage: string | null = null): void {
  getDb().prepare(`
    UPDATE pipeline_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, error_message = ?
    WHERE id = ? AND status = 'running'
  `).run(status, errorMessage, runId);
}

/** Latest run of a pipeline for a session. */
export function getLatestRun(sessionId: string, type: PipelineType, instanceId: string): PipelineRun | null {
  closeInterruptedRuns(sessionId, type, instanceId);
  return (getDb().prepare(
    'SELECT * FROM pipeline_runs WHERE session_id = ? AND pipeline_type = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId, type) as PipelineRun) ?? null;
}

/** success if nothing failed, failed if nothing succeeded, partial otherwise. */
export function outcomeStatus(processed: number, failed: number): 'success' | 'partial' | 'failed' {
  if (failed === 0) return 'success';
  return processed > 0 ? 'partial' : 'failed';
}
