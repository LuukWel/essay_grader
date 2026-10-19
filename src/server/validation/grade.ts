import type { Criterion } from '@/types';
import {
  type EssayLookup,
  type Validated,
  MAX_TEXT_LENGTH,
  criterionByName,
  essayInSession,
  invalid,
  isObject,
  optionalScore,
  valid,
} from './common';

export interface GradeFields {
  teacher_score?: number | null;
  ai_score?: number | null;
  teacher_justification?: string | null;
  ai_justification?: string | null;
  evidence_json?: string | null;
}

export interface GradeUpdate {
  essayId: string;
  criterion: Criterion;
  /** Only the fields in the request; omitted fields keep their stored value, null clears one. */
  fields: GradeFields;
}

const SCORE_FIELDS = ['teacher_score', 'ai_score'] as const;
const TEXT_FIELDS = ['teacher_justification', 'ai_justification'] as const;

/** Validates POST /api/sessions/[id]/grades against the session's criteria. */
export function validateGradeUpdate(
  body: unknown,
  ctx: { sessionId: string; getEssay: EssayLookup; criteria: Criterion[] },
): Validated<GradeUpdate> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');

  const essay = essayInSession(body.essayId, ctx.sessionId, ctx.getEssay);
  if (!essay.ok) return essay;

  const criterion = criterionByName(body.criterionName, ctx.criteria);
  if (!criterion.ok) return criterion;
  if (body.criterionId !== criterion.value.id) {
    return invalid(`criterionId ${String(body.criterionId)} does not match criterion "${criterion.value.name}"`);
  }

  const fields: GradeFields = {};

  for (const field of SCORE_FIELDS) {
    const score = optionalScore(body[field], field, criterion.value);
    if (!score.ok) return score;
    if (score.value !== undefined) fields[field] = score.value;
  }

  for (const field of TEXT_FIELDS) {
    const v = body[field];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== 'string' || v.length > MAX_TEXT_LENGTH)) {
      return invalid(`${field} must be a string of at most ${MAX_TEXT_LENGTH} characters, or null`);
    }
    fields[field] = v;
  }

  const evidence = body.evidence_json;
  if (evidence !== undefined) {
    if (evidence !== null && !isJsonArray(evidence)) {
      return invalid('evidence_json must be a JSON-encoded array, or null');
    }
    fields.evidence_json = evidence;
  }

  return valid({ essayId: essay.value.id, criterion: criterion.value, fields });
}

function isJsonArray(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return Array.isArray(JSON.parse(v));
  } catch {
    return false;
  }
}
