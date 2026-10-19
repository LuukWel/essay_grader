import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { migrate } from './migrate';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'grading.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // GRADING_DB_PATH overrides the location; tests use ':memory:'.
  const dbPath = process.env.GRADING_DB_PATH || DEFAULT_DB_PATH;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  // Apply pending migrations. Throws without changes if existing data breaks a new rule.
  migrate(conn);

  db = conn;
  return db;
}
