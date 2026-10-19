# CohortEssayGrader

A local essay-grading assistant built for a master's thesis study. Ollama suggests scores,
explanations and evidence quotes; the teacher sets the final scores.

- **Baseline:** grade essays from a list.
- **Dashboard:** browse topic groups, summaries, similar essays and benchmark essays before grading.

Both modes support editing assessments, highlighting text and precomputing AI grades.
Sessions and saved grades live in SQLite. Research events and a separate browser recorder
support later analysis. Quote checks are heuristic; they do not prove evidence is verbatim.

[Architecture](docs/architecture.md) · [Data flow](docs/data-flow.md) ·
[Database](docs/database.md) · [Testing](docs/testing.md)

[Database flowchart](docs/database-flowchart.md) shows how the tables connect.

## Setup

Requires Node.js 22+, Ollama, and Python 3.11+ for live Dashboard topic generation.
JavaScript versions are locked in `package-lock.json`; Python pins are in `requirements.txt`.

From the project root:

```bash
npm ci
ollama pull qwen2.5:7b
```

Dashboard also uses these Ollama models:

```bash
ollama pull nomic-embed-text
ollama pull gemma2:9b
```

For live topics, create a Python environment and install its packages:

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`.
The first topic run downloads `BAAI/bge-large-en-v1.5` through SentenceTransformer.
spaCy and `en_core_web_sm` are optional; without them, keyword extraction uses sklearn
stopwords. Keep that choice consistent when comparing topic results.

Create `.env.local` from [`.env.example`](.env.example) if it does not exist. Set
`TOPIC_PYTHON` to the environment's executable, for example:

```dotenv
TOPIC_PYTHON=.venv/bin/python
```

On Windows, use `TOPIC_PYTHON=.venv/Scripts/python.exe`. Keep Ollama running, then start:

```bash
npm run dev
```

Open <http://localhost:3000>, enter a participant ID and choose the **DEMO** set.
In PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.
For production, run `npm run build` followed by `npm start`.

## Configuration

Edit `.env.local` and restart the server.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Grading, revision and summaries |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Similar-essay vectors |
| `TOPIC_LLM_MODEL` | `gemma2:9b` | Topic labels |
| `TOPIC_EMBED_MODEL` | `BAAI/bge-large-en-v1.5` | Topic clustering vectors |
| `TOPIC_PYTHON` | `python` | Topic-script interpreter |
| `GRADING_DB_PATH` | `data/grading.db` | SQLite file |
| `LLM_PRECOMPUTE_TIMEOUT_MS` | `180000` | Per-assessment precompute timeout |
| `TOPIC_MODEL_TIMEOUT_MS` | `900000` | Python subprocess timeout |

Model requests go to the configured Ollama endpoint. The default is local; a remote URL
sends essay content to that server. Changing a model changes cache identities, but does not
recompute an already completed session or replace existing AI grades.

## Essay sets and rubric

Add a UTF-8 `data/subset_<NAME>.csv` file; the name may contain letters, numbers, `_` and `-`.
DEMO contains 24 synthetic essays on uniforms, classroom phones and homework, with no study data.

```csv
id,prompt,essay
S-001,Phones in class,"The full essay, including quoted commas."
```

`id` and `essay` are required; `prompt` and `word_count` are optional. IDs must be unique
within the file. Quoted fields may contain commas, doubled quotes and line breaks.
The whole file is validated before import; an invalid file creates no session or essays.
Dashboard needs at least as many essays as the selected topic count.

The rubric text is [`data/rubric/rubric.txt`](data/rubric/rubric.txt); its criteria and levels
are in [`src/lib/llm-config.ts`](src/lib/llm-config.ts). Change `RUBRIC_ID` when changing
either definition. Stored rubric versions cannot be changed through the app; existing
sessions keep their original version.

Grading prompts live in [`llm-grading.ts`](src/server/services/llm-grading.ts).
Bump `GRADING_PROMPT_VERSION` after changing them. The score scale is fixed at 1–5 in the
database and prompt; another scale needs code and schema changes.

## Stored data

The server opens and migrates SQLite on first use. Back up an existing database before
upgrading; copy it while the app is stopped. To reset server data, stop the app and remove
the database and its `-wal`/`-shm` companion files after backing up anything needed.

The browser's participant-keyed CSV recorder is separate and survives session completion.
CSV/JSON exports contain selected research data; they are not complete database backups.
See [database.md](docs/database.md) for tables, cache identities and migrations.

## Checks

```bash
npm test
npm run test:python
npm run lint
npx tsc --noEmit
```

These checks use fake models or Python helpers and need no running Ollama service.
[testing.md](docs/testing.md) covers HTTP smoke checks and manual model checks.

## Limits and troubleshooting

- Intended for one local server and trusted users. There is no login or durable job queue.
  Restarted work needs a new run; successful cached results can be reused.
- Similarity compares every pair of essays; model calls run sequentially. Large sets are slow.
- Evidence matching is permissive, and client event logging is best-effort. Review quotes and
  research timing data before relying on them.
- Model tags do not identify exact weights. Python preprocessing and CSV order can also affect
  topics without changing their cache key. See [data-flow.md](docs/data-flow.md).
- The build fetches a Google Font and needs network access on an uncached build.

For topic failures, check `TOPIC_PYTHON`, imports in that environment and `[topics:py]` output.
For Ollama errors, check that it is running and `ollama list` contains the configured models;
read the error body for load or memory failures. Raise a timeout only if the model needs more
time. Saved failure reasons and counts are in `pipeline_runs` and failed `ai_assessments`.
