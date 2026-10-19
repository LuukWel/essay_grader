# Data flow

How data moves through the system. File references point to where each step happens.

## 1. Session creation and essay import

```text
UI: study setup (participant, condition, essay set, options)
  ↓  POST /api/sessions
resume check: unfinished session with same participant + condition + set?
  ├─ yes → return existing session and essays (nothing re-imported)
  └─ no  ↓
read data/rubric/rubric.txt and data/subset_<SET>.csv
  ↓
parse + validate the whole file (strict RFC 4180, BOM stripped)
  collect every error with its line number:
  missing columns, empty file, bad quoting, wrong field count,
  empty id / essay, duplicate id, non-numeric word_count, k > number of essays
  ├─ any error → 400 with the list, nothing written
  └─ valid ↓
BEGIN
  store the rubric if its id is new (rubrics, rubric_criteria, rubric_levels)
    same id stored with other criteria or text → 409, nothing written
  INSERT sessions row (rubric_id)
  INSERT one essays row per CSV row   (filename = "essay-<csv id>")
COMMIT        (any failed insert → ROLLBACK: no session, no essays)
  ↓
log session_start → return session + rubric text + its criteria + essays
```

Where: `src/app/api/sessions/route.ts` (HTTP), `src/server/services/session-service.ts`
(transaction), `src/server/validation/essay-import.ts` (CSV contract),
`src/server/files/essay-sets.ts` (file access).

The CSV's `id` is stored in `essays.filename` as `essay-<id>` (`datasetId()` in
`src/server/db/essays.ts` reads it back). It is unique per session, checked during import
and by a unique key in the database.

The rubric comes from `RUBRIC_ID` and `RUBRIC_CRITERIA` in `src/lib/llm-config.ts` and the
text of `data/rubric/rubric.txt` (`activeRubric()` in `src/server/files/essay-sets.ts`). A
session keeps the rubric it was created with; the grading screen and all validation use that
rubric's criteria.

## 2. Cohort pipeline (Dashboard condition)

```text
POST /api/sessions/[id]/process
  latest run succeeded?  → 200 complete
  run in progress?       → 202 (no second run)
  else INSERT pipeline_runs (running, expected = #essays) → 202, runs in background
  ↓
A. summaries     status = 'summarising'
   per essay: essay_summaries[key(text, model, prompt version)] or Ollama chat
   → essays.summary                    (failure: essay counted as failed, others continue)
  ↓
B. topics        status = 'topics'
   session already has topics → keep them (and the teacher's manual changes)
   else research CSV (optional) or
        topic_models[key(set, essay texts, k, models, method)] or
        Python script (BGE → KMeans → c-TF-IDF → gemma label), output validated
   → topics rows + one 'model' topic_assignments row per essay in ONE transaction
     (failure: run failed)
  ↓
C. similarities  status = 'similarities'
   per essay: essay_embeddings[key(text, model, input version)] or Ollama /api/embed
     vector length must match the length stored for that model (else the essay fails)
   top-5 cosine neighbours per essay → replace essay_similarities in ONE transaction,
     each row with the embedding model and input version
  ↓
pipeline_runs: success | partial (some essays failed) | failed (nothing worked / topic step)
sessions.processing_status: 'complete', or 'error' when the run failed
```

Where: `src/server/services/cohort-processing.ts` (workflow), `src/server/services/topic-model.ts` and
`src/server/integrations/topic-python.ts` (topics), `src/lib/similarity.ts`.

The UI polls `GET /api/sessions/[id]`, which returns `processing_status`, progress counts
from the tables, and the latest run. After a partial run the processing screen lists what
failed and offers **Retry failed items** (a new run; stored results are reused, so only the
missing work is redone) or **Continue anyway**.

Notes:
- A run left `running` by a server that stopped is reported as `interrupted` and does not
  block a new run.
- Similarity is O(n²) in memory, which is fine for tens to a few hundred essays.

## 3. AI grade precompute

```text
POST /api/sessions/[id]/precompute
  INSERT pipeline_runs (running, expected = #essays × #criteria) → 202, runs in background
  ↓
for each essay × criterion of the session's rubric:
  grade already has ai_score?                       → done
  key = (essay text, criterion as prompted, model, prompt version, style)
  session allows reuse and ai_assessments[key] is a success → use it
  else Ollama grading call, aborted after LLM_PRECOMPUTE_TIMEOUT_MS (default 180 s)
     reply validated: integer score in range, justification, evidence list
     ├─ usable  → ai_assessments[key] = success
     └─ not     → ai_assessments[key] = failed + error, attempts + 1   → item failed
  grades (AI fields only) + essays.avg_ai_score in ONE transaction
after each essay: log quality_rank_updated (rank snapshot, research data)
  ↓
pipeline_runs: success | partial | failed, with processed / failed counts and errors
sessions.grades_precomputed = 1 only on success
```

Where: `src/server/services/grading-precompute.ts` (workflow), `src/server/services/llm-grading.ts`
(prompt), `src/server/validation/model-output.ts` (reply checks).

Notes:
- A failed item is stored with its error but is never reused as a result: the next run
  (Retry, or the next session start) asks the model again for that item only.
- The teacher's fields of a grade are never touched by precompute.
- Progress shown in the UI comes from the run's processed/failed counters.

## 4. Interactive AI grading and teacher review

```text
essay + rubric criterion + assessment style
  ↓  POST /api/llm {action: 'gradeSingleCriterion'}
prompt (GRADING_SYSTEM_PROMPT + criterion levels + essay)
  ↓
Ollama /api/chat (streamed)
  ↓
cleanJsonObject → safeParseJson → {justification, evidence[], score}
  ↓
UI: quotes checked against essay text (hallucination-utils.ts), shown to teacher
  ↓
teacher sets score / edits justification / adds highlights
  ↓  POST /api/sessions/[id]/grades, /highlights, /benchmarks   (sendJson: non-2xx throws)
validation (src/server/validation/): essay in session, criterion of the session's rubric,
  score range, offsets
  ↓
grades: saveGrade (src/server/services/grading-service.ts), ONE transaction:
  grade fields sent → essay status 'grading' → average AI score + rank snapshot
  ↓
SQLite (grades, essays, action_logs, teacher_highlights, benchmarks)
  ↓
only after a 2xx: UI moves to the next criterion / marks the essay graded
```

A score that is not a whole number in the criterion's range is returned as no score
(`error: 'INVALID_SCORE'`), and the grading screen shows the assessment as failed so the
teacher can ask again. The grades API rejects AI scores outside 1–5.

When the teacher moves an essay to another topic on the dashboard
(`PATCH /api/sessions/[id]/essays/[essayId]` with `topic_id`), a `manual` row is appended to
`topic_assignments`. The model's assignment stays in the table, and the essay's current topic
is its latest row (view `essay_current_topics`).

## 5. Research logging

```text
UI action → ActionLogger.log() → POST /api/logs {sessionId, actionType, essayId, actionDetail}
  → session must exist, and essayId (if sent) must be an essay of it (404 otherwise);
    participant, condition and essay set taken from the session
  → action_logs row, detail stored as JSON once
backend events (session_start, quality_rank_updated) → logAction() → action_logs row
  ↓
GET /api/export, /api/export/all → CSV / JSON for analysis (details decoded to objects;
  the JSON export also holds the rubric criteria and the full topic assignment history)
```

Logging is best-effort on the client: a failed log request does not interrupt grading.
The full export also decodes details stored as a JSON string that itself holds JSON, as in
the study's research data (`parseActionDetail` in `src/server/db/action-logs.ts`).
