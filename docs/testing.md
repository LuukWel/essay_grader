# Testing

Install JS dependencies first. Model calls are faked in the TypeScript tests; the Python
unit tests exercise helpers without loading ML packages.

| Command | Checks |
|---|---|
| `npm test` | Vitest unit/integration tests; SQLite in memory |
| `npm run test:python` | Topic-script input, output and text-cleaning helpers |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | TypeScript |
| `npm run db:schema` | **Writes** `src/server/db/schema.sql` from migrations; use after a schema change |

`vitest.config.mts` sets `GRADING_DB_PATH=:memory:`. Relevant files under `tests/`:

| Area | Test files |
|---|---|
| HTTP write errors | `unit/api-client.test.ts` |
| Cache identities / Ollama streams | `unit/cache-key.test.ts`, `unit/ollama-stream.test.ts` |
| CSV / request / model validation | `unit/essay-import.test.ts`, `unit/validation.test.ts`, `unit/model-output.test.ts` |
| Cosine and nearest neighbors | `unit/similarity.test.ts` |
| Ingestion and rollback | `integration/csv-ingestion.test.ts` |
| Migrations, constraints, query plans, snapshot | `integration/database.test.ts`, `integration/schema.test.ts` |
| Rubrics and query results | `integration/rubrics.test.ts`, `integration/db-queries.test.ts` |
| Grade writes and rollback | `integration/grading-save.test.ts` |
| Upgrade preservation/rollback, averages, original scores and SQL constraints | `integration/database-cleanup.test.ts` |
| Cohort / precompute / run state | `integration/cohort-processing.test.ts`, `integration/grading-precompute.test.ts`, `integration/pipeline-runs.test.ts` |

## HTTP smoke check

`tests/e2e/smoke.mjs` checks the rendered home response and API workflows: session create/resume,
validation, grades, highlights, benchmarks, completion, logging, export detail and failed model
runs. It is an HTTP script, not browser interaction automation.

Build the app, then start it with an **unused database path**, unreachable Ollama and missing
Python executable so the script can check failure recording without loading models:

```bash
npm run build
GRADING_DB_PATH=/tmp/cohort-smoke.db OLLAMA_BASE_URL=http://127.0.0.1:9 TOPIC_PYTHON=/missing-python LLM_PRECOMPUTE_TIMEOUT_MS=3000 npm start -- --hostname 127.0.0.1 -p 3123
```

In another terminal:

```bash
SMOKE_URL=http://127.0.0.1:3123 npm run smoke
```

The script assumes DEMO and 24 essays. Stop the test server afterward. Use a new DB path for
each run; existing sessions affect assertions. On PowerShell, set variables with
`$env:NAME='value'` before `npm.cmd start` or `npm.cmd run smoke` instead of Bash's inline syntax.

## Manual model checks

With Ollama models and the Python environment from the [README](../README.md#setup):

1. Start a Dashboard session on DEMO. Check summaries, topic groups and similar essays.
2. Open an essay, assign a teacher score, reveal the AI score, edit the explanation, add/remove
   highlights and save. Refresh to check persisted grades and spans.
3. Enable precompute for a new participant/session. Check completion or partial-failure warnings;
   retry failures, then confirm successful items were reused.

Automated tests cover helper logic, database behavior and fake-model workflows. They do not
establish real-model quality, quote fidelity, model-load performance or browser UI behavior.
