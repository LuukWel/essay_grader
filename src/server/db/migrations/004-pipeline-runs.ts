// Migration 4: pipeline_runs, one row per background run with its status and item counts.

import type { Migration } from '../migrate';

export const pipelineRuns: Migration = {
  version: 4,
  name: 'pipeline-runs',
  up(db) {
    db.exec(`
      CREATE TABLE pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        pipeline_type TEXT NOT NULL CHECK (pipeline_type IN ('cohort_processing', 'grading_precompute')),
        -- running: in progress; success: every item done; partial: some items failed;
        -- failed: the run stopped or nothing succeeded; interrupted: the server stopped during the run
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'interrupted')),
        instance_id TEXT NOT NULL,                 -- server process running it (src/server/instance.ts)
        input_hash TEXT NOT NULL,                  -- essays (content hashes) + configuration
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),  -- models, versions, options; no essay text
        expected_items INTEGER NOT NULL CHECK (expected_items >= 0),
        processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
        failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        error_message TEXT,
        CHECK (processed_items + failed_items <= expected_items),
        CHECK ((status = 'running') = (finished_at IS NULL))
      );

      -- One running run per session and pipeline.
      CREATE UNIQUE INDEX idx_pipeline_runs_one_running
        ON pipeline_runs (session_id, pipeline_type) WHERE status = 'running';
      -- Latest run of a session and pipeline.
      CREATE INDEX idx_pipeline_runs_latest ON pipeline_runs (session_id, pipeline_type, id);
    `);
  },
};
