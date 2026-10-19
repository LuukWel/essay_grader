# CohortEssayGrader

An essay grading assistant that runs locally. You grade the essays; a local model (via [Ollama](https://ollama.com)) suggests a score, justification and supporting quotes for each rubric criterion. Quotes are checked against the essay text and flagged if they can't be found.

There are two modes:

- **Baseline:** grade the essays one at a time.
- **Dashboard:** start from an overview of the whole set, with essays grouped by topic, a panel of similar essays, and benchmark essays to compare against.

Sessions, grades and logs are stored in a local SQLite file (`data/grading.db`). No essay text leaves your machine.

The app was built for a master's thesis study comparing the two modes; it records what the grader does for later analysis. See [docs/contribution.md](docs/contribution.md) for who built which part.

## Features

- **AI-assisted grading per criterion.** The model proposes a score, a justification and quotes; the grader sets the final score, edits the justification, highlights passages and can ask the model to revise its score.
- **Quote checking.** Every quote the model gives is looked up in the essay; quotes that cannot be found are flagged.
- **Topic groups (Dashboard).** Essays are clustered by topic (BGE embeddings, KMeans, keywords, a label written by a local model). The grader can move essays between topics; the model's grouping is kept next to the corrections.
- **Similar essays and benchmarks (Dashboard).** The five most similar essays for each essay, and a benchmark essay per criterion and score to compare against.
- **AI grades in advance.** With **Pre-compute AI assessments** on the setup screen, every essay is graded by the model before the session starts; failed items are listed and can be retried.
- **Research data.** Every grading action is logged; the export holds sessions, grades, topic history, similarities and the event log.

## How it works

```text
Browser (React UI)
   │  JSON over HTTP
   ▼
API routes (src/app/api) ──► validation (src/server/validation)
   │
   ▼
services (src/server/services): session import, grade saving,
   │                            cohort pipeline, AI grade precompute
   ├──► data access (src/server/db) ──► SQLite (data/grading.db)
   └──► integrations (src/server/integrations)
            ├─ Ollama: grading, summaries, embeddings
            └─ python/topic_model.py: topic groups (calls Ollama for labels)
```

- Model results (summaries, embeddings, AI assessments, topic groups) are stored and reused. Each is identified by everything that produced it: the essay text, the model, the prompt version, the criterion definition, the preprocessing. Changing any of these produces a new result instead of reusing an old one.
- The two background pipelines (Dashboard processing and AI grades in advance) record every run with how many items succeeded and failed. A run where some items failed is reported as `partial`, and a retry redoes only what is missing.

More: [architecture](docs/architecture.md) · [data flow](docs/data-flow.md) · [database](docs/database.md) · [testing](docs/testing.md)

## Data model

SQLite with versioned migrations (`src/server/db/migrations/`); the resulting schema is in [`src/server/db/schema.sql`](src/server/db/schema.sql).

- **Rubric:** `rubrics`, `rubric_criteria`, `rubric_levels`. Versioned; each session keeps the rubric it started with.
- **Grading:** `sessions`, `essays`, `grades`, `benchmarks`, `teacher_highlights`.
- **Topics:** `topics`, and `topic_assignments`, the history of which topic each essay is in, by the model or the grader.
- **Derived data:** `essay_similarities`, and the stored model results `essay_summaries`, `essay_embeddings`, `ai_assessments`, `topic_models`.
- **Records:** `action_logs` (what the grader did), `pipeline_runs` (what the background pipelines did).

Foreign keys include the session, so a grade, highlight or similarity can only refer to an essay of its own session. Criteria are referenced together with the rubric, so a grade can only use a criterion of that session's rubric. Scores, statuses and ranges are checked by the database as well as by the app. Details: [docs/database.md](docs/database.md).

## Requirements

- Node.js 22 or newer (24 LTS tested)
- Ollama
- Python 3.11 or newer (Dashboard mode only)
- 16 GB of RAM

A GPU with 8 GB+ of VRAM is recommended. With a smaller GPU everything works, but slowly: on a
GTX 1650 (4 GB) one AI assessment takes about a minute.

### Versions

| Component | Version | Notes |
|---|---|---|
| Node.js | 24.20.0 | In `.nvmrc`; `package.json` requires >= 22. `better-sqlite3` 12 ships prebuilt binaries for Node 22+ only; on older Node, `npm ci` has to compile it and needs a C++ build toolchain. |
| npm | 11.19.0 | Dependencies locked in `package-lock.json`; install with `npm ci`. |
| Python | 3.11.7 | Dashboard mode only. scikit-learn 1.9 requires Python 3.11 or newer. |
| sentence-transformers / scikit-learn / torch | 6.1.0 / 1.9.1 / 2.14.1 | Pinned in `requirements.txt`. |
| spaCy + `en_core_web_sm` | optional | Lemmatised topic keywords (research setup). Without it, scikit-learn stopwords are used; the topic script logs which one ran. |
| Ollama | 0.31.1 | |
| Grading model | `qwen2.5:7b` | `OLLAMA_MODEL` |
| Similarity embedding model | `nomic-embed-text` | `OLLAMA_EMBED_MODEL` |
| Topic label model | `gemma2:9b` | `TOPIC_LLM_MODEL` |
| Topic clustering embeddings | `BAAI/bge-large-en-v1.5` | `TOPIC_EMBED_MODEL`, from Hugging Face |

## Setup

```bash
git clone https://github.com/LuukWell/CohortEssayGrader.git
cd CohortEssayGrader
npm ci
```

Pull the models (the last two are only needed for Dashboard mode):

```bash
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
ollama pull gemma2:9b
```

For Dashboard mode, install the Python packages for the topic script in a virtual environment:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt            # Windows: .venv\Scripts\pip install -r requirements.txt
```

The first topic run also downloads `BAAI/bge-large-en-v1.5` (about 1.3 GB) from Hugging Face.

Copy the settings template. The defaults match the models above.

```bash
cp .env.example .env.local      # Windows: copy .env.example .env.local
```

Set `TOPIC_PYTHON` in `.env.local` to the Python that has the packages, e.g. `TOPIC_PYTHON=.venv/bin/python` (Windows: `.venv/Scripts/python.exe`).

Start the app and open <http://localhost:3000>:

```bash
npm run dev
```

On the setup screen, enter a participant ID, choose a mode and the **DEMO** essay set, and start.

## Configuration

Settings are read from `.env.local` (template: `.env.example`).

| Variable | Default | Used for |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | all Ollama calls |
| `OLLAMA_MODEL` | `qwen2.5:7b` | AI grading, score revision, essay summaries |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | similar essays |
| `TOPIC_LLM_MODEL` | `gemma2:9b` | topic labels |
| `TOPIC_EMBED_MODEL` | `BAAI/bge-large-en-v1.5` | topic clustering |
| `TOPIC_PYTHON` | `python` | the Python that runs `python/topic_model.py` |
| `GRADING_DB_PATH` | `data/grading.db` | database file |
| `LLM_PRECOMPUTE_TIMEOUT_MS` | `180000` | time allowed per AI assessment when grading in advance |
| `TOPIC_MODEL_TIMEOUT_MS` | `900000` | time allowed for the topic script |

## Essays

Each `data/subset_<NAME>.csv` file appears on the setup screen as "Set NAME".

The repository ships one set, **DEMO** (`data/subset_DEMO.csv`): 24 short argumentative essays on three prompts (school uniforms, phones in class, homework), deliberately of mixed quality; one of them drifts off topic. They were written for this repository and contain no student or study data.

The format:

```csv
id,prompt,essay
S-001,Essay Prompt 1,The full essay text.
```

`id` and `essay` are required, `prompt` and `word_count` are optional. Other columns are ignored. Fields containing commas, quotes or line breaks must be wrapped in double quotes, with quotes inside doubled (`""`).

The whole file is checked before anything is stored: every row needs a non-empty `id` and `essay`, the same number of fields as the header, and an `id` that is unique in the file. If anything is wrong, no session is created and the setup screen lists the problems with their line numbers.

Stored model results are identified by the essay **text**, not its `id`: editing an essay simply produces new results.

For topic groups, use at least as many essays as the number of topics you choose. Around 20 or more works best.

## Changing the rubric

The rubric is defined in two places:

- `data/rubric/rubric.txt`: the rubric text shown to the grader.
- `src/lib/llm-config.ts`: `RUBRIC_ID` and `RUBRIC_CRITERIA`, the criteria, score range and level descriptions the model grades against.

A rubric is stored in the database with the first session that uses it, and a stored rubric is never changed. **When you change either file, also change `RUBRIC_ID`** (e.g. to `essay-v2`). Otherwise starting a session fails with a message saying that rubric is already stored with different contents. Existing sessions keep the rubric they started with.

Stored AI assessments are tied to each criterion's definition, so editing a level description makes that criterion be graded again; unchanged criteria reuse their results.

The grading prompt is `GRADING_SYSTEM_PROMPT` in `src/server/services/llm-grading.ts`. It assumes a 1-5 scale (the database enforces it too); adjust it if yours is different. When you change the prompt, increase `GRADING_PROMPT_VERSION` next to it: stored assessments are only reused for the same version.

## Changing models

Set the model variables in `.env.local` (see [Configuration](#configuration)) and restart. The grading model must reliably return JSON.

Stored results record the model that produced them, so after switching a model the next run computes new results; nothing needs to be reset. Model names are Ollama tags: re-pulling a tag with different weights is not detected.

## Data and resetting

Everything is stored in `data/grading.db`. To back up, copy it while the app is stopped. To start fresh, stop the app and delete `data/grading.db*`.

The schema is upgraded automatically on startup (see [docs/database.md](docs/database.md#migrations-and-schemasql)). Back up an existing database before running a new version. If existing data breaks a rule a new version enforces, the upgrade stops without changing anything and the error names the table and the problem.

To clear stored model results of one kind (`ai_assessments`, `essay_summaries`, `essay_embeddings` or `topic_models`):

```bash
node -e "require('better-sqlite3')('data/grading.db').exec('DELETE FROM ai_assessments')"
```

Each background run (Dashboard processing, AI grades in advance) is recorded in `pipeline_runs` with how many items succeeded and failed, so its outcome can be checked after the terminal output is gone.

## Tests

```bash
npm test               # unit and integration tests (Vitest, in-memory SQLite, fake models)
npm run test:python    # Python unit tests for the parts of the topic script without ML packages
npm run smoke          # end-to-end checks against a running server; see tests/e2e/smoke.mjs
npm run lint
npx tsc --noEmit
```

None of these need Ollama or the Python ML packages. After adding a migration, run `npm run db:schema` to update `src/server/db/schema.sql` (a test fails until you do). See [docs/testing.md](docs/testing.md) for what each suite covers and how to check the model-dependent features.

## Known limitations

- **One machine, one grader at a time.** There is no login: anyone who can reach the server can open any session.
- **Background work runs inside the web server.** No job queue; essays are processed one at a time and a run cannot be cancelled. A server restart marks a running run `interrupted`; start it again to continue.
- **Local models are slow on small GPUs.** Grading all 24 DEMO essays in advance is 72 model calls, about an hour on a 4 GB GPU.
- **Similarity compares every pair of essays in memory.** Fine for a class of essays, not for large collections.
- **The score scale is 1–5.** It is written into the database checks and the grading prompt.
- **Model output varies.** Results are stored and reused, but a new run of the same model may give a different score.

## Troubleshooting

- **Topic step fails:** the reason is shown on the processing screen and in the terminal output prefixed with `[topics:py]`. Usually Python isn't found (set `TOPIC_PYTHON`) or the packages are installed in a different Python.
- **Topic labelling fails with "Ollama returned HTTP 500":** usually not enough free memory to load `gemma2:9b` next to the other models. Close other programs and choose **Retry**; summaries already made are reused.
- **Topic step fails while downloading the BGE model:** a dropped connection to Hugging Face. Choose **Retry**; once downloaded, the model is cached.
- **"Model not found":** Ollama isn't running, or the model hasn't been pulled. Check with `ollama list`.
- **Grading times out:** use a smaller model or raise `LLM_PRECOMPUTE_TIMEOUT_MS`. Failed essay/criterion pairs are reported on the processing screen; **Retry failed items** grades only those again.
- **"Rubric … is already stored with different criteria or text":** the rubric files were changed without a new `RUBRIC_ID`; see [Changing the rubric](#changing-the-rubric).
- **Essay set doesn't appear:** the file must be directly in `data/` and named `subset_<NAME>.csv` (letters, numbers, `-`, `_`).
