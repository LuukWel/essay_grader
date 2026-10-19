# Architecture

## Overview

```text
Teacher / researcher
        │
        ▼
React / Next.js UI              src/app/page.tsx, src/components/
        │  fetch()
        ▼
Next.js API routes              src/app/api/              HTTP in/out, call validation and services
        │
        ├──► Validation          src/server/validation/    request bodies, CSV files, model output
        ▼
Services                        src/server/services/      workflows: session import, grade saving,
        │                                                 cohort processing, AI grading precompute
   ┌────┴─────────────┐
   ▼                  ▼
Data access         Integrations
src/server/db/      src/server/integrations/
(all SQL)            ├─ ollama.ts         HTTP to Ollama (chat, embeddings)
   │                 └─ topic-python.ts   child process: python/topic_model.py
   ▼
SQLite (data/grading.db)
```


## Where to find things

| | |
|---|---|
| HTTP endpoints | `src/app/api/` |
| Workflows | `src/server/services/` |
| SQL and migrations | `src/server/db/`; the full schema as SQL in `src/server/db/schema.sql` |
| Rubric definition | `src/lib/llm-config.ts` (id and criteria), `data/rubric/rubric.txt` (text) |
| Ollama and the Python topic model | `src/server/integrations/`, `python/` |
| Input checks | `src/server/validation/` |
| Essay sets, rubric | `data/`, read by `src/server/files/` |
| UI | `src/app/page.tsx`, `src/components/`, `src/hooks/` |
| Shared and browser helpers | `src/lib/` |


### API routes (`src/app/api/`)

| Route | Purpose |
|---|---|
| `POST /api/sessions` | Create (or resume) a session and import its essays from a CSV; returns the rubric text and criteria. |
| `GET/PATCH /api/sessions/[id]` | Session state, rubric criteria, essays, topics, stats, progress and latest runs; mark complete. |
| `POST /api/sessions/[id]/process` | Start the cohort pipeline in the background. |
| `POST/GET /api/sessions/[id]/precompute` | Start / poll AI grade precompute. |
| `GET/POST /api/sessions/[id]/grades` | Read / update grades for one essay. |
| `GET/POST/DELETE /api/sessions/[id]/highlights` | Teacher text highlights. |
| `GET/POST/DELETE /api/sessions/[id]/benchmarks` | Benchmark essays per criterion and score. |
| `GET/PATCH /api/sessions/[id]/essays/[essayId]` | One essay; update status, flag, topic (appended to the topic history). |
| `GET .../essays/[essayId]/similar` | Top-5 similar essays. |
| `GET /api/sessions/[id]/rank-history` | Quality-rank snapshots from `action_logs`. |
| `POST /api/llm` | Interactive model calls: `gradeSingleCriterion`, `reviseCriterionScore`. |
| `POST /api/logs` | Append a research event. |
| `GET /api/export`, `/api/export/all` | CSV / JSON export of logs and results. |
| `GET/DELETE /api/cache/topics` | Stored topic models for a set's current essays / clear them. |
| `GET /api/essay-sets` | List available `data/subset_<NAME>.csv` sets. |
| `GET /api/instance` | Server process ID, so the client can detect a restart. |


### Validation (`src/server/validation/`)

Runtime checks on everything that comes from outside: request bodies (`session.ts`,
`grade.ts`, `highlight.ts`, `benchmark.ts`, `essay.ts`), essay CSV files (`essay-import.ts`)
and model replies (`model-output.ts`). Each returns either a typed value or an error with
an HTTP status; nothing is written until the input is valid. Criteria are checked against
the session's own rubric, which the routes load from the database (`getSessionCriteria`).

### Services (`src/server/services/`)

| Service | Workflow |
|---|---|
| `session-service.ts` | Validate the whole CSV, then store the rubric (if new), the session and its essays in one transaction. |
| `grading-service.ts` | Save a teacher's grade with what depends on it (essay status, average AI score, rank snapshot) in one transaction. |
| `cohort-processing.ts` | Summaries → topics (as model topic assignments) → embeddings (dimension-checked) → similarities, recorded as a pipeline run. |
| `grading-precompute.ts` | AI assessment for every essay × criterion of the session's rubric, recorded as a pipeline run. |
| `llm-grading.ts` | The grading and score-revision prompts, their version, and clean-up of the model's JSON. |
| `topic-model.ts` | Topic model lookup by input identity, computed through the Python integration when missing. |

The two pipelines run in the background of the Node process. Their model calls and the topic
model are passed in as dependencies, so tests run them with fakes. Each run is a row in
`pipeline_runs` with expected / processed / failed counts and a final status (`success`,
`partial`, `failed`, `interrupted`). A unique index allows one running run per session and
pipeline.

### Data access (`src/server/db/`)

Opens SQLite (WAL, `foreign_keys = ON`), applies versioned migrations on first use, and
provides one function per query, grouped per table. All SQL lives here. See
[database.md](database.md).

### Integrations (`src/server/integrations/`)

| | `ollama.ts` | `topic-python.ts` |
|---|---|---|
| Does | Base URL and model names; streamed chat (NDJSON); embeddings; timeouts via `AbortSignal`. | Starts `python/topic_model.py`: JSON job on stdin, JSON result on stdout, progress on stderr; 15-minute timeout. |
| Checks | Error frames, truncated streams and invalid embeddings raise errors; an unreachable server is reported with its address. | The result must have 1..k labelled topics and a valid topic for every essay. |
| Can fail when | Ollama is not running, a model is not pulled, a call times out, a reply is not JSON. | Python or its packages are missing, the BGE model cannot be downloaded, Ollama fails while labelling, the run times out. |

Prompts live with the code that uses them (`llm-grading.ts` for grading, the cohort service
for summaries), each with a version number that is part of the stored result's identity.

## Design notes

- **Stored model results are identified by their inputs**: essay text hash, model, prompt
  version, criterion definition and preprocessing (`src/lib/cache-key.ts`). The dataset essay
  ID is not part of the identity.
- **Partial results are explicit.** One failed essay does not stop a pipeline; the run ends
  `partial`, the processing screen lists what failed, and **Retry failed items** redoes only
  what is missing, reusing stored results.
- **Failures are recorded, not reused.** A failed AI assessment is stored with its error and
  attempt count, and asked again on the next run.
- **The database enforces the data model.** Foreign keys include the session (and, for
  criteria, the rubric), so a row cannot point at another session's essay or at a criterion
  outside the session's rubric. Validation gives clear errors first; the constraints are the
  guarantee.
- **Rubrics are versioned reference data.** A stored rubric never changes; a changed rubric
  gets a new id, and each session keeps the one it started with.
- **History is appended, not overwritten.** Topic assignments keep the model's choice and
  every teacher correction; research events and pipeline runs are append-only too.
- **Migrations do not delete data.** A migration that meets rows breaking a new rule, or rows
  it cannot carry over without guessing, stops and changes nothing; cache tables whose rows
  cannot be given an input-based key are kept as `legacy_*`.
- **Quote checking** (`src/lib/hallucination-utils.ts`) counts an AI evidence quote as found
  when it appears in the essay exactly, as a run of at least three words, or with a fuzzy
  similarity of at least 0.7.

## Known limitations

- One machine, one teacher at a time, no authentication. Background jobs run inside the web
  server process.
- Similarity compares every pair of essays in memory, which suits a class of essays, not
  large collections.
- `next build` warns that the whole project is traced, because the topic integration starts
  a process whose executable comes from `TOPIC_PYTHON`. Running the app is not affected.
