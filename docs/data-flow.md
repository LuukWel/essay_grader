# Data flow

CSV import is ETL-style: read, normalize/validate, then insert. AI processing later reads
stored essays, computes results outside SQLite and saves derived data.

## Session creation

`StudySetup` -> `POST /api/sessions` -> `validateSessionInput()` -> `createSessionWithEssays()`.

An unfinished session matching participant, condition and set is resumed with its saved
options. Otherwise the server reads the rubric/CSV and validates every row before inserting:
required columns, quoting, record width, nonblank text/IDs, duplicates and optional word counts.
Embedded newlines become LF; Dashboard requires k <= essay count.

One transaction stores/verifies the rubric, creates the session and inserts essays. Bad CSV
returns 400; a changed definition under an existing rubric ID returns 409. Insert failures
roll back the batch. The CSV ID goes into `dataset_essay_id`; the essay gets a UUID. The UI
displays the derived label `essay-<id>`.
`session_start` is logged after commit, so that log can fail after the import succeeded.

Code: [`sessions/route.ts`](../src/app/api/sessions/route.ts),
[`session-service.ts`](../src/server/services/session-service.ts),
[`essay-import.ts`](../src/server/validation/essay-import.ts).

## Cohort processing

`POST .../process` returns an existing running/completed result or starts a background run.
The UI polls the session every two seconds.

```text
summaries    content/model/prompt cache -> Ollama on miss -> essays.summary
topics       keep existing topics, else research CSV or cached/live Python result
             -> topics + model assignments in one transaction
similarity   vector cache -> Ollama on miss -> dimension checks -> cosine/top-five
             -> replace essay_similarities in one transaction
```

Python uses BGE, KMeans, cluster-document TF-IDF and Gemma labels; its output is validated.
Neighbor vectors use `nomic-embed-text` on the first 8,000 characters. Pairwise computation
costs O(n²d), plus per-essay sorting.

Summary/vector failures affect individual essays; a topic error fails the run. Partial runs
set session status to `complete`, but retain `partial` in `pipeline_runs`. Retry starts a new
run and reuses results. Existing topics preserve teacher moves; incomplete research CSV
assignments only warn.

Code: [`cohort-processing.ts`](../src/server/services/cohort-processing.ts),
[`topic-model.ts`](../src/server/services/topic-model.ts),
[`topic-python.ts`](../src/server/integrations/topic-python.ts),
[`topic_model.py`](../python/topic_model.py), [`similarity.ts`](../src/lib/similarity.ts).

## AI precompute

`POST .../precompute` skips disabled/completed sessions and avoids a second running attempt.
For each essay/criterion, it keeps an existing AI score or reuses a successful assessment when
allowed. Otherwise it calls Ollama with a timeout (default 180 seconds).

Usable output needs an integer score in range and a nonblank explanation. Evidence must be a
list if supplied; malformed entries are dropped. Quotes are not verified against the essay.
Success/failure and attempts go into `ai_assessments`; successful grades preserve teacher
fields. Averages are calculated from saved grades. Rank snapshots are logged after each essay.
Only full success sets `grades_precomputed`; failed items remain retryable.

Code: [`grading-precompute.ts`](../src/server/services/grading-precompute.ts),
[`llm-grading.ts`](../src/server/services/llm-grading.ts),
[`model-output.ts`](../src/server/validation/model-output.ts).

## Interactive grading

`POST /api/llm` buffers, cleans and parses an Ollama reply. An invalid score becomes null
with an error. In a study session, the UI saves the initial valid AI result before allowing
edits; SQLite retains that first score. Interactive calls do not populate the assessment cache.
Editing a justification can request a revised score, whose output lacks full validation.

On Next/Finish, `POST .../grades` validates ownership, criterion identity, scores, text lengths
and encoded evidence-array shape. `saveGrade()` upserts supplied fields, marks progress for a
teacher score and logs ranks for an AI-score change (including a clear), in one transaction.
Omission keeps a field; null clears it. `original_ai_score` is server-owned. Finishing separately
PATCHes graded status and returns the mean calculated from saved teacher scores.
Failed writes stop navigation.

Highlights require valid offsets/exact text; benchmarks use criterion/score slots. Topic moves
append manual assignments, preserving the model's row.

Code: [`grading-workspace.tsx`](../src/components/grading/grading-workspace.tsx),
[`grading-service.ts`](../src/server/services/grading-service.ts),
[`validation/`](../src/server/validation/), [`api-client.ts`](../src/lib/api-client.ts).

## Logs, exports and reuse limits

Client events go through `/api/logs`; session metadata comes from the server. Logging has no
HTTP-status check or retry. Some callers put essay IDs only in detail JSON, which the export's
per-essay timing calculation does not use.

- `/api/export` downloads action-log CSV.
- `/api/export/all` selects session/criterion/essay/grade/benchmark/topic-history/neighbor/event
  rows and timing estimates. It omits source bodies, grade evidence, topic definitions,
  highlights, caches and run records.
- `CsvRecorder` keeps a separate participant-keyed localStorage history across sessions.

Restart clears the browser session pointer, but setup can resume the unfinished DB session.
Old-process running jobs become interrupted on lookup/start.

Cache keys do not pin weights or all Python inputs: preprocessing mode is not keyed and Python
may prefer CSV text/order over supplied essays. Completed runs/existing scores also skip work;
changing configuration does not guarantee regeneration of an existing session.

Code: [`action-logger.ts`](../src/lib/action-logger.ts),
[`exports.ts`](../src/server/db/exports.ts), [`csv-recorder.ts`](../src/lib/csv-recorder.ts),
[`use-session.ts`](../src/hooks/use-session.ts), [`cache-key.ts`](../src/lib/cache-key.ts).
