// Validates model replies before they are stored: valid JSON isn't enough, the score,
// justification and evidence must have the right shape.

import type { Criterion } from '@/types';
import { type Validated, invalid, valid } from './common';

export interface UsableAssessment {
  score: number;
  /** Paragraph, or bullet points joined with newlines. */
  justification: string;
  /** JSON array of evidence objects, each with a `quote` string. */
  evidenceJson: string;
}

export function validateAssessment(raw: unknown, criterion: Pick<Criterion, 'scoreRange'>): Validated<UsableAssessment> {
  if (typeof raw !== 'object' || raw === null) return invalid('model reply is not an object');
  const r = raw as { score?: unknown; justification?: unknown; evidence?: unknown; error?: unknown };

  const { min, max } = criterion.scoreRange;
  if (typeof r.score !== 'number' || !Number.isInteger(r.score) || r.score < min || r.score > max) {
    const reason = typeof r.error === 'string' ? ` (${r.error})` : '';
    return invalid(`score ${JSON.stringify(r.score ?? null)} is not an integer from ${min} to ${max}${reason}`);
  }

  const justification = Array.isArray(r.justification)
    ? r.justification.filter((s): s is string => typeof s === 'string').join('\n')
    : r.justification;
  if (typeof justification !== 'string' || !justification.trim()) return invalid('justification is missing');

  const evidence = r.evidence ?? [];
  if (!Array.isArray(evidence)) return invalid('evidence is not a list');
  // Drop malformed quotes instead of rejecting the whole assessment.
  const quotes = evidence.filter(
    (e): e is { quote: string } => typeof e === 'object' && e !== null && typeof (e as { quote?: unknown }).quote === 'string',
  );

  return valid({ score: r.score, justification: justification.trim(), evidenceJson: JSON.stringify(quotes) });
}
