// Session creation on an in-memory database: valid files import fully, invalid files or
// failed inserts leave nothing behind.

import fs from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/server/db/client';
import { getEssaysBySession } from '@/server/db/essays';
import { ImportError, createSessionWithEssays } from '@/server/services/session-service';
import type { SessionInput } from '@/server/validation/session';
import { TEST_RUBRIC } from '../helpers';

const fixture = (name: string) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');

const input: SessionInput = {
  participantId: 'P01',
  condition: 'baseline',
  essaySet: 'TEST',
  usePrecomputedTopics: false,
  precomputedK: null,
  precomputeGrades: false,
  useCachedAssessments: false,
  assessmentType: 'flow',
  assessmentLength: 'medium',
};

const source = (csvText: string) => ({ csvText, csvPath: 'tests/fixtures/test.csv', rubric: TEST_RUBRIC });

function counts() {
  return getDb().prepare(
    'SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM essays) AS essays',
  ).get() as { sessions: number; essays: number };
}

function importError(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ImportError) return err;
    throw err;
  }
  throw new Error('expected an ImportError');
}

beforeEach(() => {
  const db = getDb();
  db.exec('DROP TRIGGER IF EXISTS fail_on_essay; DELETE FROM essays; DELETE FROM sessions;');
});

describe('createSessionWithEssays', () => {
  it('creates the session with every essay from a valid file', () => {
    const sessionId = createSessionWithEssays(input, source(fixture('essays-valid.csv')));

    const essays = getEssaysBySession(sessionId);
    expect(counts()).toEqual({ sessions: 1, essays: 5 });
    expect(essays.map((e) => e.filename)).toEqual(['essay-V01', 'essay-V02', 'essay-V03', 'essay-V04', 'essay-V05']);

    const v02 = essays[1];
    expect(v02.essay_text).toBe('She said "no" to the dress code.\nIt was a short, two-line essay.');
    expect(v02.word_count).toBe(13);
    expect(v02.essay_prompt).toBe('Uniforms');
    expect(essays[0].word_count).toBe(10); // counted from the text: no word_count given
  });

  it('reads a file with a byte order mark and Windows line endings the same way', () => {
    const windows = '﻿' + fixture('essays-valid.csv').replace(/\n/g, '\r\n');
    const sessionId = createSessionWithEssays(input, source(windows));
    expect(getEssaysBySession(sessionId).map((e) => e.filename)).toHaveLength(5);
  });

  it('imports the demo essay set shipped in data/', () => {
    const demo = fs.readFileSync(new URL('../../data/subset_DEMO.csv', import.meta.url), 'utf-8');
    const sessionId = createSessionWithEssays({ ...input, condition: 'dashboard', precomputedK: 3 }, source(demo));
    const essays = getEssaysBySession(sessionId);
    expect(essays).toHaveLength(24);
    expect(new Set(essays.map((e) => e.essay_prompt)).size).toBe(3);
  });

  it('rejects an invalid file with every problem listed and writes nothing', () => {
    const err = importError(() => createSessionWithEssays(input, source(fixture('essays-invalid.csv'))));

    expect(err.errors).toEqual([
      'Line 3: essay text is empty',
      'Line 4: id is empty',
      'Line 5: duplicate id "I01" (first used on line 2)',
      'Line 6: expected 3 fields, found 5',
    ]);
    expect(counts()).toEqual({ sessions: 0, essays: 0 });
  });

  it('rejects more topics than essays for the dashboard condition', () => {
    const dashboard = { ...input, condition: 'dashboard' as const, precomputedK: 6 };
    const err = importError(() => createSessionWithEssays(dashboard, source(fixture('essays-valid.csv'))));
    expect(err.errors).toEqual(['6 topics need at least 6 essays; this set has 5']);
    expect(counts()).toEqual({ sessions: 0, essays: 0 });
  });

  it('rolls back the session and earlier essays when an insert fails halfway', () => {
    // Make the database reject the 4th essay, after the session and 3 essays are inserted.
    getDb().exec(`
      CREATE TRIGGER fail_on_essay BEFORE INSERT ON essays WHEN NEW.dataset_essay_id = 'V04'
      BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;
    `);

    expect(() => createSessionWithEssays(input, source(fixture('essays-valid.csv')))).toThrow('simulated insert failure');
    expect(counts()).toEqual({ sessions: 0, essays: 0 });
  });
});
