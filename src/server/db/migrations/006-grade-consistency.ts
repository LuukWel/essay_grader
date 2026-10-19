// Upgrade version 5 without changing its released migrations. Rebuilds retain IDs,
// timestamps and AUTOINCREMENT sequences. Invalid existing rows abort the transaction.
import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

const TABLES = [
  'rubrics', 'rubric_criteria', 'rubric_levels', 'sessions', 'essays', 'topics',
  'topic_assignments', 'grades', 'benchmarks', 'teacher_highlights', 'essay_similarities',
  'essay_summaries', 'essay_embeddings', 'ai_assessments', 'topic_models',
  'pipeline_runs', 'action_logs',
];

const JSON_TYPES: Record<string, Record<string, string>> = {
  topics: { keywords: 'array' },
  grades: { evidence_json: 'array' },
  ai_assessments: { evidence_json: 'array' },
  essay_embeddings: { embedding_json: 'array' },
  topic_models: { topics_json: 'array', assignments_json: 'object' },
  pipeline_runs: { config_json: 'object' },
};

const ESSAY_COLUMNS: Record<string, string> = {
  filename: 'dataset_essay_id', pdf_path: 'source_path', pdf_content: 'essay_text',
};

function rangeTriggers(table: string, columns: string[]): string {
  // Leave missing parents to the FK check so it reports the actual relationship error.
  const outside = columns.map((c) => `(NEW.${c} IS NOT NULL AND
    NEW.${c} NOT BETWEEN rc.min_score AND rc.max_score)`).join(' OR ');
  return ['INSERT', 'UPDATE'].map((event) => `
    CREATE TRIGGER ${table}_score_range_${event.toLowerCase()} BEFORE ${event} ON ${table}
    WHEN EXISTS (SELECT 1 FROM rubric_criteria rc
      WHERE rc.rubric_id = NEW.rubric_id AND rc.criterion_id = NEW.criterion_id
        AND (${outside}))
    BEGIN SELECT RAISE(ABORT, 'score outside criterion range'); END;
  `).join('\n');
}

function up(db: Database.Database): void {
  const definitions = TABLES.map((table) => {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string };
    const columns = db.pragma(`table_info(${table})`) as { name: string; type: string }[];
    return { table, sql, columns };
  });
  const indexes = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all() as { tbl_name: string; sql: string }[];
  const sequences = db.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[];

  // These are derived values: after upgrade, reads calculate them from criterion grades.
  db.exec('DROP VIEW essay_current_topics');
  db.pragma('legacy_alter_table = ON');
  try {
    for (const table of TABLES) db.exec(`ALTER TABLE ${table} RENAME TO old_${table}`);
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }

  for (const { table, sql, columns } of definitions) {
    const lines = sql.replace(/--[^\n]*/g, '').trim().split('\n').map((line) => line.trimEnd());
    const body = lines.slice(1, -1);
    const indent = Math.min(...body.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
    let create = [lines[0], ...body.filter((line) => line.trim()).map((line) => `  ${line.slice(indent)}`), ')'].join('\n')
      .replace(/TEXT PRIMARY KEY/g, 'TEXT NOT NULL PRIMARY KEY');
    const kept = columns.filter((c) => table !== 'essays' || !['overall_grade', 'avg_ai_score'].includes(c.name));
    if (table === 'essays') {
      create = create.replace(/^.*\b(?:overall_grade|avg_ai_score) REAL[^\n]*\n/gm, '');
      for (const [old, name] of Object.entries(ESSAY_COLUMNS)) create = create.replace(new RegExp(`\\b${old}\\b`, 'g'), name);
    }
    const checks = kept.filter((c) => c.type === 'INTEGER')
      .map((c) => `CHECK (${c.name} IS NULL OR typeof(${c.name}) = 'integer')`);
    for (const [column, type] of Object.entries(JSON_TYPES[table] ?? {})) {
      checks.push(`CHECK (${column} IS NULL OR (json_valid(${column}) AND json_type(${column}) = '${type}'))`);
    }
    if (table === 'essays') checks.push('CHECK (length(trim(dataset_essay_id)) > 0)');
    if (checks.length) {
      const end = create.lastIndexOf(')');
      create = `${create.slice(0, end).trimEnd()},\n  ${checks.join(',\n  ')}\n)`;
    }
    db.exec(create);
    const names = kept.map((c) => table === 'essays' ? (ESSAY_COLUMNS[c.name] ?? c.name) : c.name);
    const values = kept.map((c) => table === 'essays' && c.name === 'filename'
      ? "CASE WHEN substr(filename, 1, 6) = 'essay-' THEN substr(filename, 7) ELSE filename END"
      : c.name);
    try {
      db.exec(`INSERT INTO ${table} (${names.join(', ')}) SELECT ${values.join(', ')} FROM old_${table}`);
    } catch (error) {
      throw new Error(`copying ${table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const table of [...TABLES].reverse()) db.exec(`DROP TABLE old_${table}`);
  for (const index of indexes.filter((i) => TABLES.includes(i.tbl_name))) db.exec(index.sql);
  for (const { name, seq } of sequences.filter((s) => TABLES.includes(s.name))) {
    // Preserve the high-water mark even if the highest-ID row was deleted earlier.
    const current = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name) as { seq: number } | undefined;
    db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name);
    db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, Math.max(seq, current?.seq ?? 0));
  }

  db.exec(`
    CREATE TRIGGER grades_original_score_valid_insert BEFORE INSERT ON grades
    WHEN NEW.original_ai_score IS NOT NULL AND NEW.original_ai_score IS NOT NEW.ai_score
    BEGIN SELECT RAISE(ABORT, 'original AI score must be the first AI score'); END;

    CREATE TRIGGER grades_original_score_valid_update BEFORE UPDATE OF original_ai_score ON grades
    WHEN OLD.original_ai_score IS NULL AND NEW.original_ai_score IS NOT NULL
      AND NEW.original_ai_score IS NOT NEW.ai_score
    BEGIN SELECT RAISE(ABORT, 'original AI score must be the first AI score'); END;

    CREATE VIEW essay_current_topics AS
      SELECT ta.session_id, ta.essay_id, ta.topic_id, ta.source, ta.assigned_at
      FROM topic_assignments ta
      WHERE ta.id = (SELECT MAX(id) FROM topic_assignments latest WHERE latest.essay_id = ta.essay_id);

    CREATE VIEW essay_scores AS
      SELECT e.id AS essay_id,
        (SELECT AVG(g.teacher_score) FROM grades g WHERE g.session_id = e.session_id AND g.essay_id = e.id) AS overall_grade,
        (SELECT AVG(g.ai_score) FROM grades g WHERE g.session_id = e.session_id AND g.essay_id = e.id) AS avg_ai_score
      FROM essays e;
  `);
  // Existing original scores are preserved. The current score is the only available
  // baseline for older rows that never recorded an original.
  db.exec('UPDATE grades SET original_ai_score = ai_score WHERE original_ai_score IS NULL AND ai_score IS NOT NULL');
  db.exec(`
    CREATE TRIGGER grades_original_score_preserve BEFORE UPDATE OF original_ai_score ON grades
    WHEN OLD.original_ai_score IS NOT NULL AND NEW.original_ai_score IS NOT OLD.original_ai_score
    BEGIN SELECT RAISE(ABORT, 'original AI score cannot change'); END;

    CREATE TRIGGER grades_original_score_insert AFTER INSERT ON grades
    WHEN NEW.original_ai_score IS NULL AND NEW.ai_score IS NOT NULL
    BEGIN UPDATE grades SET original_ai_score = NEW.ai_score WHERE id = NEW.id; END;

    CREATE TRIGGER grades_original_score_first_ai AFTER UPDATE OF ai_score ON grades
    WHEN NEW.original_ai_score IS NULL AND NEW.ai_score IS NOT NULL
    BEGIN UPDATE grades SET original_ai_score = NEW.ai_score WHERE id = NEW.id; END;
  `);
  for (const [table, columns] of Object.entries({
    rubric_levels: ['score'], grades: ['teacher_score', 'ai_score', 'original_ai_score'], benchmarks: ['score'],
  })) {
    // Validate old rows too; triggers only protect writes after this migration.
    const bad = columns.map((c) => `(t.${c} IS NOT NULL AND t.${c} NOT BETWEEN rc.min_score AND rc.max_score)`).join(' OR ');
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table} t JOIN rubric_criteria rc
      USING (rubric_id, criterion_id) WHERE ${bad}`).get() as { n: number };
    if (n) throw new Error(`${table}: ${n} row(s) with a score outside its criterion range`);
    db.exec(rangeTriggers(table, columns));
  }
  db.exec(`
    CREATE TRIGGER rubric_criteria_preserve_ranges BEFORE UPDATE OF min_score, max_score ON rubric_criteria
    WHEN EXISTS (SELECT 1 FROM rubric_levels WHERE rubric_id = OLD.rubric_id AND criterion_id = OLD.criterion_id
      AND score NOT BETWEEN NEW.min_score AND NEW.max_score)
      OR EXISTS (SELECT 1 FROM grades WHERE rubric_id = OLD.rubric_id AND criterion_id = OLD.criterion_id
        AND (teacher_score NOT BETWEEN NEW.min_score AND NEW.max_score
          OR ai_score NOT BETWEEN NEW.min_score AND NEW.max_score
          OR original_ai_score NOT BETWEEN NEW.min_score AND NEW.max_score))
      OR EXISTS (SELECT 1 FROM benchmarks WHERE rubric_id = OLD.rubric_id AND criterion_id = OLD.criterion_id
        AND score NOT BETWEEN NEW.min_score AND NEW.max_score)
    BEGIN SELECT RAISE(ABORT, 'criterion range excludes existing scores'); END;
  `);
}

export const gradeConsistency: Migration = { version: 6, name: 'grade-consistency', up };
