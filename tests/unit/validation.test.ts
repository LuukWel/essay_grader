import { describe, expect, it } from 'vitest';
import type { EssayLookup, EssayRef } from '@/server/validation/common';
import { validateGradeUpdate } from '@/server/validation/grade';
import { validateHighlightInput } from '@/server/validation/highlight';
import { validateSessionInput } from '@/server/validation/session';
import { validateBenchmarkInput, validateBenchmarkRemoval } from '@/server/validation/benchmark';
import { validateEssayUpdate } from '@/server/validation/essay';
import { RUBRIC_CRITERIA as criteria } from '@/lib/llm-config';

const ESSAY_TEXT = 'School uniforms should be optional. They limit self-expression.';
const essays: Record<string, EssayRef> = {
  'essay-1': { id: 'essay-1', session_id: 'session-A', pdf_content: ESSAY_TEXT },
  'essay-2': { id: 'essay-2', session_id: 'session-B', pdf_content: 'Another session.' },
};
const getEssay: EssayLookup = (id) => essays[id] ?? null;
const ctx = { sessionId: 'session-A', getEssay, criteria };

// Criterion 1 is "Content", scored 1-5 (src/lib/llm-config.ts).
const grade = (extra: Record<string, unknown>) => ({
  essayId: 'essay-1', criterionName: 'Content', criterionId: 1, ...extra,
});

describe('grade validation', () => {
  it('accepts a valid score and keeps only the fields that were sent', () => {
    const result = validateGradeUpdate(grade({ teacher_score: 4, teacher_justification: null }), ctx);
    expect(result).toMatchObject({ ok: true, value: { essayId: 'essay-1', criterion: { id: 1 } } });
    // ai_score etc. were not sent, so they must not be overwritten with null.
    expect(result.ok && result.value.fields).toEqual({ teacher_score: 4, teacher_justification: null });
  });

  it.each([0, 6, 3.5, '4', Number.NaN])('rejects teacher_score %s', (score) => {
    const result = validateGradeUpdate(grade({ teacher_score: score }), ctx);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects an essay from another session as not found', () => {
    const result = validateGradeUpdate({ ...grade({ teacher_score: 3 }), essayId: 'essay-2' }, ctx);
    expect(result).toEqual({ ok: false, status: 404, error: 'Essay not found in this session' });
  });

  it('rejects an unknown criterion and a mismatched criterionId', () => {
    expect(validateGradeUpdate(grade({ criterionName: 'Style' }), ctx).ok).toBe(false);
    expect(validateGradeUpdate(grade({ criterionId: 2 }), ctx).ok).toBe(false);
  });

  it('requires evidence_json to be a JSON array', () => {
    expect(validateGradeUpdate(grade({ evidence_json: '[{"quote":"x"}]' }), ctx).ok).toBe(true);
    expect(validateGradeUpdate(grade({ evidence_json: '{"quote":"x"}' }), ctx).ok).toBe(false);
    expect(validateGradeUpdate(grade({ evidence_json: 'not json' }), ctx).ok).toBe(false);
  });

  it('rejects a body that is not an object', () => {
    expect(validateGradeUpdate(undefined, ctx).ok).toBe(false);
    expect(validateGradeUpdate([grade({})], ctx).ok).toBe(false);
  });
});

describe('highlight validation', () => {
  const highlight = (start: unknown, end: unknown, text?: unknown) => ({
    essayId: 'essay-1',
    criterionName: 'Content',
    startIndex: start,
    endIndex: end,
    text: text ?? (typeof start === 'number' && typeof end === 'number' ? ESSAY_TEXT.slice(start, end) : ''),
  });

  it('accepts a range whose text matches the essay', () => {
    expect(validateHighlightInput(highlight(0, 14), ctx)).toMatchObject({
      ok: true, value: { startIndex: 0, endIndex: 14, text: 'School uniform' },
    });
    expect(validateHighlightInput(highlight(0, ESSAY_TEXT.length), ctx).ok).toBe(true);
  });

  it.each([
    ['negative start', -1, 5],
    ['empty range', 5, 5],
    ['reversed range', 10, 5],
    ['past the end', 0, ESSAY_TEXT.length + 1],
    ['fractional offset', 0.5, 5],
    ['string offset', '0', 5],
  ])('rejects %s', (_, start, end) => {
    expect(validateHighlightInput(highlight(start, end, 'x'), ctx).ok).toBe(false);
  });

  it('rejects text that does not match the essay at those offsets', () => {
    const result = validateHighlightInput(highlight(0, 6, 'Uniforms'), ctx);
    expect(result).toMatchObject({ ok: false, error: 'text does not match the essay at the given offsets' });
  });

  it('rejects a highlight on another session\'s essay', () => {
    expect(validateHighlightInput({ ...highlight(0, 5), essayId: 'essay-2' }, ctx)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('session validation', () => {
  const isEssaySet = (name: string) => name === 'X';
  const base = { participantId: ' P01 ', condition: 'dashboard', essaySet: 'X' };

  it('fills in defaults and trims the participant ID', () => {
    expect(validateSessionInput(base, { isEssaySet })).toEqual({
      ok: true,
      value: {
        participantId: 'P01', condition: 'dashboard', essaySet: 'X',
        usePrecomputedTopics: false, precomputedK: null, precomputeGrades: true,
        useCachedAssessments: false, assessmentType: 'flow', assessmentLength: 'medium',
      },
    });
  });

  it.each([
    ['unknown condition', { condition: 'cohort' }],
    ['unknown essay set', { essaySet: 'Z' }],
    ['blank participant', { participantId: '   ' }],
    ['k below range', { precomputedK: 1 }],
    ['k above range', { precomputedK: 11 }],
    ['non-integer k', { precomputedK: 4.5 }],
    ['non-boolean flag', { precomputeGrades: 'yes' }],
    ['unknown assessment type', { assessmentType: 'essay' }],
  ])('rejects %s', (_, change) => {
    expect(validateSessionInput({ ...base, ...change }, { isEssaySet }).ok).toBe(false);
  });
});

describe('benchmark validation', () => {
  it('resolves the criterion to its id and keeps the score as the slot', () => {
    expect(validateBenchmarkInput({ essayId: 'essay-1', criterionName: 'Content', score: 4, type: '4' }, ctx))
      .toEqual({ ok: true, value: { essayId: 'essay-1', criterionId: 1, score: 4 } });
  });

  it('rejects a criterion that is not in the rubric of the session', () => {
    const otherRubric = [{ ...criteria[0], id: 7, name: 'Argument' }];
    expect(validateBenchmarkInput({ essayId: 'essay-1', criterionName: 'Content', score: 4 }, { ...ctx, criteria: otherRubric }))
      .toMatchObject({ ok: false, error: 'Unknown criterion "Content"' });
  });

  it('rejects a missing score, an out-of-range score and a type that disagrees', () => {
    const b = { essayId: 'essay-1', criterionName: 'Content' };
    expect(validateBenchmarkInput(b, ctx).ok).toBe(false);
    expect(validateBenchmarkInput({ ...b, score: 9 }, ctx).ok).toBe(false);
    expect(validateBenchmarkInput({ ...b, score: 4, type: '3' }, ctx).ok).toBe(false);
  });

  it('only removes a slot that is a valid score', () => {
    expect(validateBenchmarkRemoval({ criterionName: 'Content', type: '3' }, criteria)).toEqual({ ok: true, value: { criterionId: 1, score: 3 } });
    expect(validateBenchmarkRemoval({ criterionName: 'Content', type: 'high' }, criteria).ok).toBe(false);
  });
});

describe('essay update validation', () => {
  it('accepts a topic of this session and rejects one of another session', () => {
    expect(validateEssayUpdate({ topic_id: 7 }, { topicIds: [7, 8], criteria }))
      .toEqual({ ok: true, value: { topic: { topicId: 7 } } });
    expect(validateEssayUpdate({ topic_id: null }, { topicIds: [7, 8], criteria }))
      .toEqual({ ok: true, value: { topic: { topicId: null } } });
    expect(validateEssayUpdate({ topic_id: 99 }, { topicIds: [7, 8], criteria }).ok).toBe(false);
  });

  it('checks grading status and overall grade', () => {
    expect(validateEssayUpdate({ grading_status: 'graded', overall_grade: 3.7 }, { topicIds: [], criteria }).ok).toBe(true);
    expect(validateEssayUpdate({ grading_status: 'done' }, { topicIds: [], criteria }).ok).toBe(false);
    expect(validateEssayUpdate({ grading_status: 'graded', overall_grade: 7 }, { topicIds: [], criteria }).ok).toBe(false);
  });
});
