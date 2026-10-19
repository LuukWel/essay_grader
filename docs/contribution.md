# Contribution

CohortEssayGrader started as a research prototype for a master's thesis. This page records
who built what.

<!-- TODO(author): fill in sections 1 and 2. Only list what you can back up
     (commit history, thesis text, supervisor confirmation). -->

## 1. Baseline platform (inherited)

<!-- What existed before you started, and who built it (group, supervisor, earlier student)?
     e.g. baseline grading workspace, interactive AI grading, evidence highlighting, … -->

- TODO

## 2. Built for the thesis

<!-- What did you build for the thesis study?
     e.g. Dashboard condition, topic grouping (BGE + KMeans + Gemma labels), similar-essays
     panel, benchmarks, research logging and export, AI grade precompute, … -->

- TODO

## 3. Built after the thesis

- Service layer for session import, grade saving, cohort processing and AI precompute
  (`src/server/services/`), with the data access in `src/server/db/` and the Ollama and
  Python integrations in `src/server/integrations/`
- Versioned database migrations with foreign keys, unique keys, value checks and indexes,
  and a generated `schema.sql` checked against them
- The rubric as versioned tables referenced by grades, benchmarks and highlights; topic
  assignments as an append-only history; embedding model recorded on similarities
- Runtime validation of requests, essay CSV files and model output
- Stored model results identified by all of their inputs; pipeline run records with
  success / partial / failed counts and retries of failed items
- Test suites (Vitest, Python unittest, end-to-end smoke test), the synthetic DEMO essay set,
  and the documentation in `docs/`
