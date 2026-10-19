# Architecture

One Next.js application serves the React UI and HTTP API. Model calls go to Ollama;
live topic generation runs a Python subprocess. SQLite stores application and research data.

```text
React components -> HTTP routes -> validators / services
                                       |          |
                                       v          v
                                  DB modules   integrations
                                       |          |-- Ollama HTTP
                                       v          `-- Python topic script
                                     SQLite            `-- Ollama labels
```

## Code map

| Path | Responsibility |
|---|---|
| `src/app/page.tsx` | Switches between setup, processing, lists, grading and analytics on `/` |
| `src/app/layout.tsx`, `globals.css` | Page shell, font, theme and global styling |
| `src/app/api/**/route.ts` | HTTP handlers: parse requests, return JSON or export files |
| `src/components/` | Setup/navigation plus `grading/`, `cohort/`, `analytics/` and shared `ui/` components |
| `src/hooks/use-session.ts` | Browser session restore and recorder/logger lifecycle |
| `src/server/validation/` | Session, CSV, grade, highlight, benchmark, essay-update and precompute-output checks |
| `src/server/services/` | Import, grade saving, cohort processing, precompute and model prompts/cache lookup |
| `src/server/db/` | Connection, queries, migrations and generated `schema.sql` |
| `src/server/files/` | Essay-set discovery, rubric reads and optional research-topic CSV |
| `src/server/integrations/` | Ollama transport and Python subprocess adapter |
| `src/lib/` | Browser HTTP/logging/CSV helpers, rubric constants, hashes, quote checks and similarity math |
| `src/types/` | Shared TypeScript interfaces; these do not validate runtime data |
| `python/topic_model.py` | BGE embeddings, KMeans, cluster-document TF-IDF and Gemma labels |

`src/app` follows Next.js routing conventions. `page.tsx` renders a page; `route.ts` exports
HTTP methods. `[id]` is a variable URL segment. Components elsewhere do not create URLs.

## HTTP API

Paths below are relative to `/api`. There are 17 route files and 26 handlers.

| Path | Methods | Purpose |
|---|---|---|
| `/sessions` | POST | Create or resume a session |
| `/sessions/[id]` | GET, PATCH | Session snapshot; mark complete |
| `/sessions/[id]/process` | POST | Start cohort processing |
| `/sessions/[id]/precompute` | GET, POST | Poll/start AI precompute |
| `/sessions/[id]/grades` | GET, POST | Read/save criterion grades |
| `/sessions/[id]/essays/[essayId]` | GET, PATCH | Read essay; change status, flag or topic |
| `/sessions/[id]/essays/[essayId]/similar` | GET | Read five nearest essays |
| `/sessions/[id]/highlights` | GET, POST, DELETE | Teacher text spans |
| `/sessions/[id]/benchmarks` | GET, POST, DELETE | Benchmark score slots |
| `/sessions/[id]/rank-history` | GET | Rank snapshots |
| `/llm` | POST | Interactive grading and score revision |
| `/logs` | POST | Research event |
| `/export`, `/export/all` | GET each | Action-log CSV; selected research JSON |
| `/cache/topics` | GET, DELETE | List current-input cached k values; clear topic cache |
| `/essay-sets`, `/instance` | GET each | Available sets; server-instance identity |

## Boundaries

Routes use runtime validators for application writes. The interactive `/llm` route checks
the action but casts its payload without a full schema check; model-output validation is
stronger in precompute. Some read routes return empty lists for absent resources.

`getDb()` opens SQLite lazily, enables WAL/FKs and applies migrations. Services use short
transactions for related writes; model requests run outside those transactions.

Ollama chat is streamed as NDJSON, then buffered into a complete reply before the browser
receives it. Precompute supplies an abort timeout; interactive grading and summaries do not.
The Python adapter sends JSON on stdin, reads JSON from stdout, forwards stderr progress,
validates assignments and kills the child after the configured timeout (default 15 minutes).

Both background pipelines run inside Node. `pipeline_runs` records counts and outcomes;
a partial unique index allows one running row per session/pipeline. Another process's running
row is treated as interrupted on lookup/start, so multiple live server processes are unsupported.

See [data-flow.md](data-flow.md) for workflows, [database.md](database.md) for storage and
[testing.md](testing.md) for checks.
