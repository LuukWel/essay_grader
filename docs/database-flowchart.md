# Database map

**17 tables and 2 views**, stored in SQLite (`data/grading.db` by default).

## Overview

```mermaid
flowchart TB
    DB["SQLite database<br/>17 tables + 2 views"]
    DB --> R["Rubric definitions<br/>3 tables"]
    DB --> S["Session data<br/>8 tables"]
    DB --> O["Jobs and research events<br/>2 tables"]
    DB --> C["Reusable model results<br/>4 tables"]
    DB --> V(["Calculated views<br/>2 views"])

    classDef root fill:#0f172a,stroke:#0f172a,color:#ffffff
    classDef rubric fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef operations fill:#f5f3ff,stroke:#7c3aed,color:#4c1d95
    classDef cache fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f8fafc,stroke:#64748b,color:#334155,stroke-dasharray:5 4
    class DB root
    class R rubric
    class S study
    class O operations
    class C cache
    class V view
```

**Legend:** Overview arrows mean "contains". Other solid arrows run from parent to child
through a foreign key; dotted arrows show calculations. `PK` identifies a row, `FK` references
another table, and `+` joins columns into one key.

## 1. Rubrics and session ownership

```mermaid
flowchart LR
    R["rubrics<br/>PK: id"] --> C["rubric_criteria<br/>PK: rubric_id<br/>+ criterion_id"]
    C --> L["rubric_levels<br/>PK: rubric_id<br/>+ criterion_id + score"]
    R --> S["sessions<br/>PK: id"]
    S --> E["essays<br/>PK: id"]

    classDef rubric fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    class R,C,L rubric
    class S,E study
```

Each imported essay has its own UUID; `dataset_essay_id` retains the original CSV ID.

## 2. Grading and teacher work

```mermaid
flowchart LR
    E["essays<br/>PK: id"] --> G["grades<br/>PK: id"]
    E --> B["benchmarks<br/>PK: id"]
    E --> H["teacher_highlights<br/>PK: id"]

    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    class E,G,B,H study
```

Shared FKs for `grades`, `benchmarks` and `teacher_highlights`:

| FK columns in each child | Referenced table | What it guarantees |
|---|---|---|
| `essay_id + session_id` | `essays` | Same session |
| `session_id + rubric_id` | `sessions` | Session's rubric |
| `rubric_id + criterion_id` | `rubric_criteria` | Valid rubric criterion |

## 3. Topics and assignment history

```mermaid
flowchart LR
    S["sessions<br/>PK: id"] --> T["topics<br/>PK: id"]
    T --> A["topic_assignments<br/>PK: id"]
    E["essays<br/>PK: id"] --> A

    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    class S,T,A,E study
```

Assignments retain placement history. FKs: `essay_id + session_id` and `topic_id + session_id`.
A manual assignment with a null topic removes the essay from its group.

## 4. Similar essays

Both essay boxes refer to the same `essays` table.

```mermaid
flowchart LR
    A["essays: source (A)"] -->|"essay_id_a<br/>+ session_id"| N["essay_similarities<br/>PK: session_id<br/>+ essay_id_a<br/>+ essay_id_b"]
    B["essays: neighbour (B)"] -->|"essay_id_b<br/>+ session_id"| N

    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    class A,B,N study
```

Neighbours stay within one session. A listing B does not require B to list A; up to five
neighbours are stored per essay.

## 5. Jobs and research events

```mermaid
flowchart LR
    S["sessions<br/>PK: id"] --> P["pipeline_runs<br/>PK: id"]
    S --> O["action_logs<br/>PK: id"]
    E["essays<br/>PK: id"] -->|"optional essay reference"| O

    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef operations fill:#f5f3ff,stroke:#7c3aed,color:#4c1d95
    class S,E study
    class P,O operations
```

Logs may omit `essay_id`; otherwise `essay_id + session_id` must reference an essay in
that session.

## 6. Reusable model results

All four use `cache_key` as their PK and have **no FKs**. Matching inputs allow reuse
across sessions.

| Table | Saved result | Used for |
|---|---|---|
| `essay_summaries` | Summary text | Filling `essays.summary` |
| `essay_embeddings` | Vector and dimension count | Calculating similar-essay scores |
| `ai_assessments` | Assessment result/failure and attempts | AI precompute reuse |
| `topic_models` | Topic definitions and dataset-ID assignments | Creating session topics and initial placements |

Key inputs: [cache identities](database.md#model-result-identities).

## 7. Calculated views

Views calculate results when read; their boxes are rounded and dashed.

```mermaid
flowchart LR
    G["grades"] -. "calculate means" .-> S(["essay_scores<br/>Teacher and AI means"])
    A["topic_assignments"] -. "latest per essay" .-> T(["essay_current_topics<br/>Latest assignment"])

    classDef study fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef view fill:#f8fafc,stroke:#64748b,color:#334155,stroke-dasharray:5 4
    class G,A study
    class S,T view
```

`essay_scores` ignores null scores; no scores gives a null mean. `essay_current_topics`
selects the highest assignment ID per essay.

Full definitions: [schema.sql](../src/server/db/schema.sql). All 21 FKs and migration details:
[database.md](database.md).
