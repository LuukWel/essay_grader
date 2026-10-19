// BGE + Gemma topic models. Computed by the Python script once, then cached by input.

import { topicInputHash, topicModelKey } from '@/lib/cache-key';
import { getTopicModel, saveTopicModel, type TopicModelInputs, type TopicModelResult } from '@/server/db/caches';
import { TOPIC_EMBED_MODEL, TOPIC_LLM_MODEL, runTopicScript } from '@/server/integrations/topic-python';

export { TOPIC_EMBED_MODEL, TOPIC_LLM_MODEL };
export const DEFAULT_TOPIC_K = 5;
/** Bump when python/topic_model.py changes how topics are computed or labelled. */
export const TOPIC_METHOD_VERSION = 1;

// Concurrent sessions with the same inputs share one Python run instead of racing.
const inFlight = new Map<string, Promise<TopicModelResult>>();

/** The inputs that identify a topic model for these essays (also used by the setup screen). */
export function topicModelInputs(essaySet: string, k: number, essays: { tsvId: string; text: string }[]): TopicModelInputs {
  const identity = {
    essaySet,
    inputHash: topicInputHash(essays),
    k,
    embedModel: TOPIC_EMBED_MODEL,
    llmModel: TOPIC_LLM_MODEL,
    methodVersion: TOPIC_METHOD_VERSION,
  };
  return { key: topicModelKey(identity), ...identity };
}

/** Topics for an essay set; assignments are keyed by tsv_id. */
export async function getOrComputeTopicModel(
  essaySet: string,
  k: number,
  essays: { tsvId: string; text: string }[],
): Promise<TopicModelResult & { source: 'cache' | 'computed' }> {
  const inputs = topicModelInputs(essaySet, k, essays);
  const stored = getTopicModel(inputs.key);
  if (stored) return { ...stored, source: 'cache' };

  let job = inFlight.get(inputs.key);
  if (!job) {
    job = runTopicScript({ essaySet, k, essays })
      .then(({ preprocessing, ...result }) => {
        saveTopicModel(inputs, result, preprocessing);
        return result;
      })
      .finally(() => inFlight.delete(inputs.key));
    inFlight.set(inputs.key, job);
  }
  return { ...(await job), source: 'computed' };
}
