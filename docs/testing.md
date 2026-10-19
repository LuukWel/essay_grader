# Testing

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | Unit and integration tests (Vitest), on an in-memory SQLite database with fake models | Node |
| `npm run test:python` | Unit tests for the topic script's input, output and text cleaning | Python (no ML packages) |
| `npm run smoke` | End-to-end checks over HTTP against a running server | A running server, see below |
| `npm run lint`, `npx tsc --noEmit` | Lint and type check | Node |
| `npm run db:schema` | Rewrites `src/server/db/schema.sql` from the migrations (after adding one) | Node |

## Unit and integration tests (`tests/`)

| Area | Files |
|---|---|
| Ollama stream parsing | `unit/ollama-stream.test.ts` |
| Result identities (cache keys) | `unit/cache-key.test.ts` |
| Request validation, model output checks | `unit/validation.test.ts`, `unit/model-output.test.ts` |
| CSV import rules | `unit/essay-import.test.ts`, `integration/csv-ingestion.test.ts` |
| Similarity and nearest neighbours | `unit/similarity.test.ts` |
| Client error handling for saves | `unit/api-client.test.ts` |
| Migrations, constraints, query plans | `integration/database.test.ts` |
| `schema.sql` matches the migrations | `integration/schema.test.ts` |
| Rubric storage, versions and conflicts | `integration/rubrics.test.ts` |
| Data access queries | `integration/db-queries.test.ts` |
| Saving grades | `integration/grading-save.test.ts` |
| Cohort processing and AI precompute (fake models), incl. topic history and embedding dimensions | `integration/cohort-processing.test.ts`, `integration/grading-precompute.test.ts` |
| Pipeline run records | `integration/pipeline-runs.test.ts` |

Integration tests use the app's data access code on an in-memory database
(`GRADING_DB_PATH=:memory:`, set in `vitest.config.mts`).

## End-to-end smoke test (`tests/e2e/smoke.mjs`)

Runs the built app against a new database with Ollama unreachable, so both background
pipelines fail and the checks cover how failures are recorded:

```bash
npm run build
GRADING_DB_PATH=/tmp/smoke.db OLLAMA_BASE_URL=http://127.0.0.1:9 LLM_PRECOMPUTE_TIMEOUT_MS=3000 npm start -- -p 3123
npm run smoke        # in a second terminal; SMOKE_URL overrides http://localhost:3123
```

It covers session import and resume (with the rubric's criteria), input validation, grades,
highlights, benchmarks, essay and session completion, research logging (including a rejected
event about another session's essay) and export, and the `failed` runs of AI precompute and
cohort processing. The checks assume the DEMO essay set and that the topic
model cannot run.

## With the models

The model-dependent paths (AI grading, score revision, summaries, embeddings, topic
grouping) need Ollama with the models from the README and the Python packages from
`requirements.txt`. Run the app with `npm run dev`, create a Dashboard session on the DEMO
set, and check:

- the processing screen completes, and the cohort dashboard shows topics that follow the
  three prompts (uniforms, phones, homework) and a summary per essay;
- opening an essay shows an AI assessment per criterion, with evidence quotes that are found
  in the essay;
- with **Grade all essays with AI before the session starts**, the processing screen reports
  any items that failed and offers **Retry failed items**.
