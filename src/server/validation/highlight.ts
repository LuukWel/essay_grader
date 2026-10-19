import type { Criterion } from '@/types';
import {
  type EssayLookup,
  type Validated,
  criterionByName,
  essayInSession,
  invalid,
  isObject,
  valid,
} from './common';

export interface HighlightInput {
  essayId: string;
  criterionId: number;
  startIndex: number;
  endIndex: number;
  text: string;
}

/**
 * Validates POST /api/sessions/[id]/highlights. Offsets are character positions in the
 * essay, and `text` must match that slice exactly.
 */
export function validateHighlightInput(
  body: unknown,
  ctx: { sessionId: string; getEssay: EssayLookup; criteria: Criterion[] },
): Validated<HighlightInput> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');

  const essay = essayInSession(body.essayId, ctx.sessionId, ctx.getEssay);
  if (!essay.ok) return essay;

  const criterion = criterionByName(body.criterionName, ctx.criteria);
  if (!criterion.ok) return criterion;

  const { startIndex, endIndex, text } = body;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    return invalid('startIndex and endIndex must be integers');
  }
  const start = startIndex as number;
  const end = endIndex as number;
  const content = essay.value.essay_text;
  if (start < 0 || end <= start || end > content.length) {
    return invalid(`Highlight range must satisfy 0 <= startIndex < endIndex <= ${content.length}`);
  }
  if (typeof text !== 'string' || text !== content.slice(start, end)) {
    return invalid('text does not match the essay at the given offsets');
  }

  return valid({ essayId: essay.value.id, criterionId: criterion.value.id, startIndex: start, endIndex: end, text });
}
