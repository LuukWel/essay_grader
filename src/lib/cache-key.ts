// Cache keys for stored model results.
//
// A key is a SHA-256 over every input that produced the result (essay text, model, prompt
// version, ...), not the essay ID, so edited text or another model gives a new key.
// Bump the matching *_VERSION constant when a prompt or preprocessing step changes.

import { createHash } from 'crypto';

export type KeyPart = string | number;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 of an essay text as stored. */
export function contentHash(text: string): string {
  return sha256(text);
}

/** Key for a result of `kind` (e.g. "summary"). Part order doesn't matter; all parts are required. */
export function cacheKey(kind: string, parts: Record<string, KeyPart>): string {
  const entries = Object.entries(parts).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, value] of entries) {
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`cache key "${kind}": input "${name}" is missing`);
    }
  }
  return sha256(JSON.stringify([kind, entries]));
}

/** Stable JSON with sorted object keys, for hashing structured inputs such as a criterion. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Keys per kind of result

export function summaryKey(i: { contentHash: string; model: string; promptVersion: number }): string {
  return cacheKey('summary', i);
}

export function embeddingKey(i: { contentHash: string; model: string; inputVersion: string }): string {
  return cacheKey('embedding', i);
}

/** `criterionHash` covers name, score range and level descriptions, so editing a level gives a new key. */
export function assessmentKey(i: {
  contentHash: string;
  criterionHash: string;
  model: string;
  promptVersion: number;
  assessmentType: string;
  assessmentLength: string;
}): string {
  return cacheKey('assessment', i);
}

/** `inputHash` comes from topicInputHash. */
export function topicModelKey(i: {
  essaySet: string;
  inputHash: string;
  k: number;
  embedModel: string;
  llmModel: string;
  methodVersion: number;
}): string {
  return cacheKey('topics', i);
}

/** Hash of a pipeline run's inputs: the essays (ID and text) and the run configuration. */
export function runInputHash(essays: { id: string; text: string }[], config: Record<string, unknown>): string {
  return sha256(stableJson({ essays: essays.map((e) => [e.id, contentHash(e.text)]), config }));
}

/** Hash of the essays sent to the topic model (dataset IDs and texts), independent of order. */
export function topicInputHash(essays: { tsvId: string; text: string }[]): string {
  const pairs = essays.map((e) => [e.tsvId, contentHash(e.text)]).sort(([a], [b]) => a.localeCompare(b));
  return sha256(JSON.stringify(pairs));
}
