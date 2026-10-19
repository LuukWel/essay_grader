import { describe, expect, it } from 'vitest';
import { assessmentKey, cacheKey, contentHash, stableJson, topicInputHash } from '@/lib/cache-key';
import { criterionHash } from '@/server/services/llm-grading';
import { RUBRIC_CRITERIA } from '@/lib/llm-config';

const content = RUBRIC_CRITERIA[0];
const base = {
  contentHash: contentHash('Uniforms should be optional.'),
  criterionHash: criterionHash(content),
  model: 'qwen2.5:7b',
  promptVersion: 1,
  assessmentType: 'flow',
  assessmentLength: 'medium',
};

describe('assessment cache identity', () => {
  it('gives identical inputs the identical key', () => {
    expect(assessmentKey({ ...base })).toBe(assessmentKey({ ...base }));
  });

  it('misses when the essay text changes, even with the same dataset ID', () => {
    // The dataset ID isn't part of the key, only the text.
    const edited = { ...base, contentHash: contentHash('Uniforms should be optional!') };
    expect(assessmentKey(edited)).not.toBe(assessmentKey(base));
  });

  it.each([
    ['the model', { model: 'llama3.1:8b' }],
    ['the prompt version', { promptVersion: 2 }],
    ['the assessment style', { assessmentType: 'bullets' }],
    ['the assessment length', { assessmentLength: 'short' }],
  ])('misses when %s changes', (_, change) => {
    expect(assessmentKey({ ...base, ...change })).not.toBe(assessmentKey(base));
  });

  it('misses when a rubric level description changes', () => {
    const reworded = {
      ...content,
      levels: content.levels!.map((l) => (l.score === 3 ? { ...l, description: `${l.description} (reworded)` } : l)),
    };
    expect(criterionHash(reworded)).not.toBe(criterionHash(content));
    expect(assessmentKey({ ...base, criterionHash: criterionHash(reworded) })).not.toBe(assessmentKey(base));
  });
});

describe('cacheKey', () => {
  it('does not depend on the order of the inputs', () => {
    expect(cacheKey('x', { a: 1, b: 'two' })).toBe(cacheKey('x', { b: 'two', a: 1 }));
  });

  it('separates kinds of result with the same inputs', () => {
    expect(cacheKey('summary', { a: 1 })).not.toBe(cacheKey('embedding', { a: 1 }));
  });

  it('refuses a missing input instead of silently ignoring it', () => {
    expect(() => cacheKey('x', { model: undefined as unknown as string })).toThrow('input "model" is missing');
    expect(() => cacheKey('x', { k: Number.NaN })).toThrow('input "k" is missing');
  });
});

describe('helpers', () => {
  it('stableJson sorts object keys at every level', () => {
    expect(stableJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it('topicInputHash depends on texts and IDs, not on order', () => {
    const a = { tsvId: 'A', text: 'one' };
    const b = { tsvId: 'B', text: 'two' };
    expect(topicInputHash([a, b])).toBe(topicInputHash([b, a]));
    expect(topicInputHash([a, { ...b, text: 'TWO' }])).not.toBe(topicInputHash([a, b]));
    expect(topicInputHash([a])).not.toBe(topicInputHash([a, b]));
  });
});
