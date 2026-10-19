import type { Criterion } from '@/types';
import { type Validated, invalid, isObject, valid } from './common';

const GRADING_STATUSES = ['pending', 'grading', 'graded'] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

export interface EssayUpdate {
  grading?: { status: GradingStatus };
  isFlagged?: boolean;
  /** The teacher moves the essay to this topic (null: no topic). */
  topic?: { topicId: number | null };
}

/** Validates PATCH /api/sessions/[id]/essays/[essayId]. The route checks the essay's session. */
export function validateEssayUpdate(
  body: unknown,
  ctx: { topicIds: number[]; criteria: Criterion[] },
): Validated<EssayUpdate> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');
  const update: EssayUpdate = {};

  if (body.grading_status !== undefined) {
    if (!GRADING_STATUSES.includes(body.grading_status as GradingStatus)) {
      return invalid(`grading_status must be one of: ${GRADING_STATUSES.join(', ')}`);
    }
    // overall_grade is the mean teacher score, so it lies within the score range.
    const min = Math.min(...ctx.criteria.map((c) => c.scoreRange.min));
    const max = Math.max(...ctx.criteria.map((c) => c.scoreRange.max));
    const grade = body.overall_grade ?? null;
    if (grade !== null && (typeof grade !== 'number' || !Number.isFinite(grade) || grade < min || grade > max)) {
      return invalid(`overall_grade must be a number from ${min} to ${max}, or null`);
    }
    // Accept older clients' averages for compatibility, but never store their value.
    update.grading = { status: body.grading_status as GradingStatus };
  }

  if (body.is_flagged !== undefined) {
    if (typeof body.is_flagged !== 'boolean') return invalid('is_flagged must be true or false');
    update.isFlagged = body.is_flagged;
  }

  if (body.topic_id !== undefined) {
    const topicId = body.topic_id;
    if (topicId !== null && !ctx.topicIds.includes(topicId as number)) {
      return invalid('topic_id must be a topic of this session, or null');
    }
    update.topic = { topicId: topicId as number | null };
  }

  return valid(update);
}
