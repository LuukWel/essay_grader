import fs from 'fs';
import path from 'path';
import { RUBRIC_CRITERIA, RUBRIC_ID } from '@/lib/llm-config';
import type { RubricDefinition } from '@/server/db/rubrics';

const DATA_DIR = path.join(process.cwd(), 'data');
const RUBRIC_PATH = path.join(DATA_DIR, 'rubric', 'rubric.txt');

// An essay set is any data/subset_<NAME>.csv file; NAME is what the setup screen shows.
const SUBSET_FILE = /^subset_([A-Za-z0-9_-]+)\.csv$/;

export function listEssaySets(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .map((f) => SUBSET_FILE.exec(f)?.[1])
    .filter((s): s is string => !!s)
    .sort();
}

export function isEssaySet(essaySet: unknown): essaySet is string {
  return typeof essaySet === 'string' && listEssaySets().includes(essaySet);
}

/** Raw text of an essay set's CSV. Parsing and validation: src/server/validation/essay-import.ts. */
export function readEssaySetCsv(essaySet: string): { csvPath: string; csvText: string } {
  if (!isEssaySet(essaySet)) {
    throw new Error(`Unknown essay set "${essaySet}" — expected data/subset_${essaySet}.csv`);
  }
  const csvPath = path.join(DATA_DIR, `subset_${essaySet}.csv`);
  return { csvPath, csvText: fs.readFileSync(csvPath, 'utf-8') };
}

function getRubricContent(): string {
  if (!fs.existsSync(RUBRIC_PATH)) {
    throw new Error(`Rubric file not found at ${RUBRIC_PATH}`);
  }
  // Normalize CRLF so a Windows checkout gives the same rubric text.
  return fs.readFileSync(RUBRIC_PATH, 'utf-8').replace(/\r\n/g, '\n').trim();
}

/** Rubric for new sessions: id and criteria from llm-config.ts, text from rubric.txt. */
export function activeRubric(): RubricDefinition {
  return { id: RUBRIC_ID, sourceText: getRubricContent(), criteria: RUBRIC_CRITERIA };
}
