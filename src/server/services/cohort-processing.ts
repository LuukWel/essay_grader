// Cohort pipeline (Dashboard condition), started by POST /api/sessions/[id]/process and run
// in the background. Each run is recorded in pipeline_runs.
//
// Steps: summaries -> topics -> embeddings -> similarities (top 5 per essay). Model results
// are cached by their inputs, and topics are only computed once per session.
// A failed summary or embedding only fails that essay (the run ends 'partial'); a topic
// model error fails the run.

import { contentHash, embeddingKey, runInputHash, summaryKey } from '@/lib/cache-key';
import { loadPrecomputedTopics } from '@/server/files/research-topics';
import { nearestNeighbours } from '@/lib/similarity';
import { DEFAULT_TOPIC_K, TOPIC_EMBED_MODEL, TOPIC_LLM_MODEL, TOPIC_METHOD_VERSION, getOrComputeTopicModel } from '@/server/services/topic-model';
import {
  getEmbedding, getEmbeddingDimensions, getSummary, saveEmbedding, saveSummary, type TopicModelResult,
} from '@/server/db/caches';
import { getDb } from '@/server/db/client';
import { datasetId, getEssaysBySession, updateEssaySummary, type Essay } from '@/server/db/essays';
import { finishRun, getLatestRun, outcomeStatus, recordRunItem, startRun } from '@/server/db/pipeline-runs';
import { getSession, updateSessionStatus, type Session } from '@/server/db/sessions';
import { replaceSimilarities } from '@/server/db/similarities';
import { assignTopic, createTopic, getTopicsBySession } from '@/server/db/topics';
import { INSTANCE_ID } from '@/server/instance';
import { EMBED_INPUT_VERSION, OLLAMA_EMBED_MODEL, OLLAMA_MODEL, ollamaChat, ollamaEmbed } from '@/server/integrations/ollama';

/** Bump when the summary prompt below changes. */
const SUMMARY_PROMPT_VERSION = 1;
const NEIGHBOURS = 5;

/** Model calls used by the pipeline; tests pass fakes. */
export interface CohortDeps {
  summaryModel: string;
  embeddingModel: string;
  embeddingInputVersion: string;
  summarise(text: string): Promise<string>;
  embed(text: string): Promise<number[]>;
  topicModel(essaySet: string, k: number, essays: { tsvId: string; text: string }[]): Promise<TopicModelResult>;
}

const defaultCohortDeps: CohortDeps = {
  summaryModel: OLLAMA_MODEL,
  embeddingModel: OLLAMA_EMBED_MODEL,
  embeddingInputVersion: EMBED_INPUT_VERSION,
  summarise: (text) => ollamaChat(
    'You are an academic text analyst. Respond with ONLY the summary text, nothing else.',
    `Summarize this academic essay in 1-2 sentences. Focus on the main topic and argument.\n\nESSAY:\n${text.slice(0, 2000)}`,
    { temperature: 0.3, num_predict: 128 },
  ),
  embed: (text) => ollamaEmbed(text),
  topicModel: getOrComputeTopicModel,
};

export type StartResult =
  | { status: 'not_found' }
  | { status: 'complete' }
  | { status: 'running' }
  | { status: 'started'; finished: Promise<void> };

/** Starts the pipeline in the background unless it already finished or is running. */
export function startCohortProcessing(sessionId: string, deps: CohortDeps = defaultCohortDeps): StartResult {
  const session = getSession(sessionId);
  if (!session) return { status: 'not_found' };

  // Only a successful run counts as done; anything else is started again (cached results
  // make that cheap). Sessions from before pipeline_runs existed have no run.
  const latest = getLatestRun(sessionId, 'cohort_processing', INSTANCE_ID);
  if (latest?.status === 'success' || (!latest && session.processing_status === 'complete')) {
    return { status: 'complete' };
  }

  const essays = getEssaysBySession(sessionId);
  const config = {
    summaryModel: deps.summaryModel,
    summaryPromptVersion: SUMMARY_PROMPT_VERSION,
    embeddingModel: deps.embeddingModel,
    embeddingInputVersion: deps.embeddingInputVersion,
    topics: {
      k: session.precomputed_k ?? DEFAULT_TOPIC_K,
      researchCsv: session.use_precomputed_topics === 1,
      embedModel: TOPIC_EMBED_MODEL,
      llmModel: TOPIC_LLM_MODEL,
      methodVersion: TOPIC_METHOD_VERSION,
    },
  };
  const start = startRun({
    sessionId,
    type: 'cohort_processing',
    instanceId: INSTANCE_ID,
    inputHash: runInputHash(essays.map((e) => ({ id: datasetId(e), text: e.pdf_content })), config),
    config,
    expectedItems: essays.length,
  });
  if ('alreadyRunning' in start) return { status: 'running' };

  updateSessionStatus(sessionId, 'processing');
  return { status: 'started', finished: runPipeline(session, essays, start.started.id, deps) };
}

async function runPipeline(session: Session, essays: Essay[], runId: number, deps: CohortDeps): Promise<void> {
  const failures = new Map<string, string>(); // essay id -> first error
  const fail = (essay: Essay, step: string, err: unknown) => {
    const message = `${step} failed for ${essay.filename}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[cohort] ${message}`);
    if (!failures.has(essay.id)) failures.set(essay.id, message);
  };

  try {
    updateSessionStatus(session.id, 'summarising');
    await summarise(essays, deps, fail);

    updateSessionStatus(session.id, 'topics');
    await assignTopics(session, essays, deps);

    updateSessionStatus(session.id, 'similarities');
    const vectors = await embed(essays, deps, fail);
    replaceSimilarities(session.id, nearestNeighbours(vectors, NEIGHBOURS), {
      model: deps.embeddingModel, inputVersion: deps.embeddingInputVersion,
    });

    for (const essay of essays) recordRunItem(runId, failures.has(essay.id) ? 'failed' : 'processed');
    const status = outcomeStatus(essays.length - failures.size, failures.size);
    finishRun(runId, status, failures.size > 0 ? summariseErrors([...failures.values()]) : null);
    updateSessionStatus(session.id, status === 'failed' ? 'error' : 'complete');
  } catch (err) {
    // Run aborted (e.g. topic model error). Still record the essays that failed before that.
    console.error('[cohort] pipeline failed:', err);
    for (let i = 0; i < failures.size; i++) recordRunItem(runId, 'failed');
    const reason = err instanceof Error ? err.message : String(err);
    const earlier = failures.size > 0 ? ` (before that: ${summariseErrors([...failures.values()])})` : '';
    finishRun(runId, 'failed', `${reason}${earlier}`);
    updateSessionStatus(session.id, 'error');
  }
}

type FailFn = (essay: Essay, step: string, err: unknown) => void;

async function summarise(essays: Essay[], deps: CohortDeps, fail: FailFn): Promise<void> {
  for (const essay of essays) {
    const inputs = { contentHash: contentHash(essay.pdf_content), model: deps.summaryModel, promptVersion: SUMMARY_PROMPT_VERSION };
    const key = summaryKey(inputs);
    try {
      let summary = getSummary(key);
      if (!summary) {
        summary = (await deps.summarise(essay.pdf_content)).trim();
        if (!summary) throw new Error('the model returned an empty summary');
        saveSummary({ key, ...inputs }, summary);
      }
      updateEssaySummary(essay.id, summary);
    } catch (err) {
      fail(essay, 'summary', err);
    }
  }
}

async function assignTopics(session: Session, essays: Essay[], deps: CohortDeps): Promise<void> {
  // Already done: recomputing would create new topics and lose the teacher's reassignments.
  if (getTopicsBySession(session.id).length > 0) return;

  const k = session.precomputed_k ?? DEFAULT_TOPIC_K;
  const research = session.use_precomputed_topics ? loadPrecomputedTopics(session.essay_set, k) : null;
  const result = research && research.topics.length > 0
    ? research
    : await deps.topicModel(session.essay_set, k, essays.map((e) => ({ tsvId: datasetId(e), text: e.pdf_content })));

  // Topics and assignments in one transaction.
  let unassigned = 0;
  getDb().transaction(() => {
    const topicIds = result.topics.map((t, i) => createTopic(session.id, i, t.keywords, t.label));
    for (const essay of essays) {
      const index = result.assignments[datasetId(essay)];
      if (index !== undefined && topicIds[index] !== undefined) assignTopic(session.id, essay.id, topicIds[index], 'model');
      else unassigned++;
    }
  })();
  // Only happens with the research CSV if it doesn't cover every essay.
  if (unassigned > 0) console.warn(`[cohort] ${unassigned} essay(s) have no topic in the research topic file`);
}

async function embed(essays: Essay[], deps: CohortDeps, fail: FailFn): Promise<{ id: string; vec: number[] }[]> {
  // Expected vector length: from stored embeddings of this model, else the first new one.
  const stored = getEmbeddingDimensions(deps.embeddingModel, deps.embeddingInputVersion);
  if (stored.length > 1) {
    throw new Error(`stored ${deps.embeddingModel} embeddings have different dimensions (${stored.join(', ')})`);
  }
  let dimensions: number | null = stored[0] ?? null;

  const vectors: { id: string; vec: number[] }[] = [];
  for (const essay of essays) {
    const inputs = { contentHash: contentHash(essay.pdf_content), model: deps.embeddingModel, inputVersion: deps.embeddingInputVersion };
    const key = embeddingKey(inputs);
    try {
      let vec = getEmbedding(key);
      if (!vec) {
        vec = await deps.embed(essay.pdf_content);
        if (vec.length === 0 || !vec.every((x) => Number.isFinite(x))) throw new Error('the model returned an invalid embedding');
        if (dimensions !== null && vec.length !== dimensions) {
          throw new Error(`the model returned ${vec.length} dimensions, expected ${dimensions}`);
        }
        saveEmbedding({ key, ...inputs }, vec);
      }
      dimensions ??= vec.length;
      vectors.push({ id: essay.id, vec });
    } catch (err) {
      fail(essay, 'embedding', err);
    }
  }
  return vectors;
}

function summariseErrors(errors: string[]): string {
  return errors.length <= 3 ? errors.join('; ') : `${errors.slice(0, 3).join('; ')} (and ${errors.length - 3} more)`;
}
