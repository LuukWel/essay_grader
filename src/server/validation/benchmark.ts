import type { Criterion } from '@/types';
import {
  type EssayLookup,
  type Validated,
  criterionByName,
  essayInSession,
  invalid,
  isObject,
  optionalScore,
  valid,
} from './common';

export interface BenchmarkInput {
  essayId: string;
  criterionId: number;
  /** The benchmark slot: one essay per session, criterion and score. */
  score: number;
}

/** Validates POST /api/sessions/[id]/benchmarks. The optional `type` must equal the score. */
export function validateBenchmarkInput(
  body: unknown,
  ctx: { sessionId: string; getEssay: EssayLookup; criteria: Criterion[] },
): Validated<BenchmarkInput> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');

  const essay = essayInSession(body.essayId, ctx.sessionId, ctx.getEssay);
  if (!essay.ok) return essay;

  const criterion = criterionByName(body.criterionName, ctx.criteria);
  if (!criterion.ok) return criterion;

  const score = optionalScore(body.score, 'score', criterion.value);
  if (!score.ok) return score;
  if (score.value == null) return invalid('score is required');

  if (body.type !== undefined && String(body.type) !== String(score.value)) {
    return invalid('type must equal the score');
  }

  return valid({ essayId: essay.value.id, criterionId: criterion.value.id, score: score.value });
}

/** Validates DELETE /api/sessions/[id]/benchmarks: `type` is the score of the slot to clear. */
export function validateBenchmarkRemoval(
  body: unknown,
  criteria: Criterion[],
): Validated<{ criterionId: number; score: number }> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');

  const criterion = criterionByName(body.criterionName, criteria);
  if (!criterion.ok) return criterion;

  const score = optionalScore(Number(body.type), 'type', criterion.value);
  if (!score.ok || score.value == null) return invalid('type must be a score of this criterion');

  return valid({ criterionId: criterion.value.id, score: score.value });
}
