// Schema migrations. The version is kept in PRAGMA user_version (0 = new database, or one
// from before migrations existed). Each migration runs in one transaction with its version
// bump. If existing rows break a new rule the migration throws and nothing is changed.

import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export class MigrationError extends Error {
  constructor(migration: Migration, reason: string) {
    super(`Database migration ${migration.version} (${migration.name}) failed, nothing was changed: ${reason}`);
    this.name = 'MigrationError';
  }
}

export function schemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies every migration newer than the database's version. Returns the new version. */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number {
  const latest = migrations.at(-1)?.version ?? 0;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than this app supports (${latest})`);
  }

  for (const migration of migrations.filter((m) => m.version > current)) {
    // Table rebuilds need foreign keys off, and that pragma can't change inside a
    // transaction. Foreign keys are checked by hand before commit instead.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        try {
          migration.up(db);
        } catch (err) {
          throw new MigrationError(migration, err instanceof Error ? err.message : String(err));
        }
        const broken = foreignKeyViolations(db);
        if (broken.length > 0) throw new MigrationError(migration, broken.join('; '));
        db.pragma(`user_version = ${migration.version}`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  return schemaVersion(db);
}

/** "grades: 2 row(s) reference a missing row in essays", one entry per table and parent. */
function foreignKeyViolations(db: Database.Database): string[] {
  const rows = db.pragma('foreign_key_check') as { table: string; parent: string }[];
  const counts = new Map<string, number>();
  for (const { table, parent } of rows) {
    const key = `${table}: {n} row(s) reference a missing row in ${parent}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => key.replace('{n}', String(n)));
}
