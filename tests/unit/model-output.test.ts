// Model replies are validated before they are stored.

import { describe, expect, it } from 'vitest';
import { validateAssessment } from '@/server/validation/model-output';
import { parseTopicResult } from '@/server/integrations/topic-python';

const criterion = { scoreRange: { min: 1, max: 5 } };

describe('validateAssessment', () => {
  it('accepts a complete assessment and joins bullet points', () => {
    const result = validateAssessment(
      { score: 4, justification: ['Clear thesis.', 'Weak ending.'], evidence: [{ quote: 'a', paragraph: '1' }] },
      criterion,
    );
    expect(result).toEqual({
      ok: true,
      value: { score: 4, justification: 'Clear thesis.\nWeak ending.', evidenceJson: '[{"quote":"a","paragraph":"1"}]' },
    });
  });

  it.each([
    ['a missing score', { justification: 'x' }],
    ['a score out of range', { score: 7, justification: 'x' }],
    ['a fractional score', { score: 3.5, justification: 'x' }],
    ['a score as text', { score: '4', justification: 'x' }],
    ['an empty justification', { score: 3, justification: '  ' }],
    ['evidence that is not a list', { score: 3, justification: 'x', evidence: 'quote' }],
    ['a reply that is not an object', 'just text'],
  ])('rejects %s', (_, reply) => {
    expect(validateAssessment(reply, criterion).ok).toBe(false);
  });

  it('drops malformed evidence entries but keeps the assessment', () => {
    const result = validateAssessment({ score: 2, justification: 'x', evidence: [{ quote: 'ok' }, { text: 'no quote' }, 5] }, criterion);
    expect(result.ok && result.value.evidenceJson).toBe('[{"quote":"ok"}]');
  });
});

describe('parseTopicResult', () => {
  const job = { essaySet: 'X', k: 2, essays: [{ tsvId: 'A', text: '' }, { tsvId: 'B', text: '' }] };
  const topics = [{ label: 'Phones', keywords: ['phone'] }, { label: 'Uniforms', keywords: [] }];

  it('accepts a complete result and reads the preprocessing mode', () => {
    expect(parseTopicResult({ topics, assignments: { A: 0, B: 1 }, meta: { preprocessing: 'spacy-lemma' } }, job))
      .toEqual({ topics, assignments: { A: 0, B: 1 }, preprocessing: 'spacy-lemma' });
  });

  it.each([
    ['an essay without a topic', { topics, assignments: { A: 0 } }, '1 essay(s) have no topic (B)'],
    ['an assignment to a missing topic', { topics, assignments: { A: 0, B: 2 } }, 'essay B is assigned to topic 2'],
    ['more topics than k', { topics: [...topics, topics[0]], assignments: { A: 0, B: 1 } }, 'expected 1 to 2 topics'],
    ['a topic without a label', { topics: [{ label: '', keywords: [] }], assignments: { A: 0, B: 0 } }, 'topic 0 has no label'],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseTopicResult(raw, job)).toThrow(message);
  });
});
