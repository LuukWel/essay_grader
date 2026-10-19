// Shared validation helpers. Request bodies are untrusted JSON until checked here.

import type { Criterion } from '@/types';
import type { Essay } from '@/server/db/essays';

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404; error: string };

export const valid = <T>(value: T): Validated<T> => ({ ok: true, value });
export const invalid = (error: string, status: 400 | 404 = 400): Validated<never> => ({ ok: false, status, error });

/** The essay fields validation needs; routes pass a lookup backed by the database. */
export type EssayRef = Pick<Essay, 'id' | 'session_id' | 'essay_text'>;
export type EssayLookup = (essayId: string) => EssayRef | null;

/** Max length of free-text fields such as justifications. */
export const MAX_TEXT_LENGTH = 20_000;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Looks up an essay and checks it belongs to the session (404 otherwise). */
export function essayInSession(essayId: unknown, sessionId: string, getEssay: EssayLookup): Validated<EssayRef> {
  if (!isNonEmptyString(essayId)) return invalid('essayId is required');
  const essay = getEssay(essayId);
  if (!essay || essay.session_id !== sessionId) return invalid('Essay not found in this session', 404);
  return valid(essay);
}

export function criterionByName(name: unknown, criteria: Criterion[]): Validated<Criterion> {
  if (!isNonEmptyString(name)) return invalid('criterionName is required');
  const criterion = criteria.find((c) => c.name === name);
  return criterion ? valid(criterion) : invalid(`Unknown criterion "${name}"`);
}

/**
 * A score field: `undefined` (not sent), `null` (unset) or an integer in the criterion's range.
 */
export function optionalScore(
  value: unknown,
  field: string,
  criterion: Criterion,
): Validated<number | null | undefined> {
  if (value === undefined || value === null) return valid(value);
  const { min, max } = criterion.scoreRange;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return invalid(`${field} must be an integer from ${min} to ${max}, or null`);
  }
  return valid(value);
}
