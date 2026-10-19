import type { AssessmentLength, AssessmentType } from '@/types';
import { type Validated, invalid, isNonEmptyString, isObject, valid } from './common';

const CONDITIONS = ['baseline', 'dashboard'] as const;
const ASSESSMENT_TYPES: AssessmentType[] = ['flow', 'bullets'];
const ASSESSMENT_LENGTHS: AssessmentLength[] = ['short', 'medium', 'long'];
/** KMeans needs at least 2 clusters; the setup screen offers 4-10. */
const TOPIC_K_MIN = 2;
const TOPIC_K_MAX = 10;
const MAX_PARTICIPANT_ID_LENGTH = 100;

export interface SessionInput {
  participantId: string;
  condition: (typeof CONDITIONS)[number];
  essaySet: string;
  usePrecomputedTopics: boolean;
  precomputedK: number | null;
  precomputeGrades: boolean;
  useCachedAssessments: boolean;
  assessmentType: AssessmentType;
  assessmentLength: AssessmentLength;
}

/** Validates POST /api/sessions and fills in defaults for the optional settings. */
export function validateSessionInput(
  body: unknown,
  ctx: { isEssaySet: (name: string) => boolean },
): Validated<SessionInput> {
  if (!isObject(body)) return invalid('Request body must be a JSON object');

  const participantId = isNonEmptyString(body.participantId) ? body.participantId.trim() : '';
  if (!participantId || participantId.length > MAX_PARTICIPANT_ID_LENGTH) {
    return invalid(`participantId is required (at most ${MAX_PARTICIPANT_ID_LENGTH} characters)`);
  }

  const condition = body.condition;
  if (!CONDITIONS.includes(condition as SessionInput['condition'])) {
    return invalid(`condition must be one of: ${CONDITIONS.join(', ')}`);
  }

  if (typeof body.essaySet !== 'string' || !ctx.isEssaySet(body.essaySet)) {
    return invalid(`Unknown essay set "${String(body.essaySet)}"; add data/subset_<NAME>.csv`);
  }

  for (const name of ['usePrecomputedTopics', 'precomputeGrades', 'useCachedAssessments']) {
    if (body[name] !== undefined && typeof body[name] !== 'boolean') {
      return invalid(`${name} must be true or false`);
    }
  }

  const k = body.precomputedK;
  if (k !== undefined && k !== null && (!Number.isInteger(k) || (k as number) < TOPIC_K_MIN || (k as number) > TOPIC_K_MAX)) {
    return invalid(`precomputedK must be an integer from ${TOPIC_K_MIN} to ${TOPIC_K_MAX}`);
  }

  const assessmentType = body.assessmentType ?? 'flow';
  if (!ASSESSMENT_TYPES.includes(assessmentType as AssessmentType)) {
    return invalid(`assessmentType must be one of: ${ASSESSMENT_TYPES.join(', ')}`);
  }
  const assessmentLength = body.assessmentLength ?? 'medium';
  if (!ASSESSMENT_LENGTHS.includes(assessmentLength as AssessmentLength)) {
    return invalid(`assessmentLength must be one of: ${ASSESSMENT_LENGTHS.join(', ')}`);
  }

  return valid({
    participantId,
    condition: condition as SessionInput['condition'],
    essaySet: body.essaySet,
    usePrecomputedTopics: (body.usePrecomputedTopics as boolean | undefined) ?? false,
    precomputeGrades: (body.precomputeGrades as boolean | undefined) ?? true,
    useCachedAssessments: (body.useCachedAssessments as boolean | undefined) ?? false,
    precomputedK: (k as number | null | undefined) ?? null,
    assessmentType: assessmentType as AssessmentType,
    assessmentLength: assessmentLength as AssessmentLength,
  });
}
