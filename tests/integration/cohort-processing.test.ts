// Cohort pipeline with fake models: storage, reuse and partial failures.

import { describe, expect, it } from 'vitest';
import { getDb } from '@/server/db/client';
import { getEssaysBySession } from '@/server/db/essays';
import { getLatestRun } from '@/server/db/pipeline-runs';
import { getSession } from '@/server/db/sessions';
import { assignTopic, getTopicAssignments, getTopicsBySession } from '@/server/db/topics';
import { getSimilarEssays } from '@/server/db/similarities';
import { INSTANCE_ID } from '@/server/instance';
import { startCohortProcessing, type CohortDeps } from '@/server/services/cohort-processing';
import { createTestSession as createSession } from '../helpers';

const createTestSession = (essays: Record<string, string>) => createSession(essays, { condition: 'dashboard' });

const ESSAYS = {
  A: 'Phones distract students in class.',
  B: 'Phones help students research topics.',
  C: 'School uniforms limit self-expression.',
  D: 'Uniforms reduce bullying about clothes.',
};

/** Fake models that count their calls. Embeddings put phone essays and uniform essays apart. */
function fakeDeps(overrides: Partial<CohortDeps> = {}) {
  const calls = { summarise: [] as string[], embed: [] as string[], topics: 0 };
  const deps: CohortDeps = {
    summaryModel: 'fake-chat',
    embeddingModel: 'fake-embed',
    embeddingInputVersion: 'test',
    async summarise(text) { calls.summarise.push(text); return `Summary of: ${text}`; },
    async embed(text) { calls.embed.push(text); return text.includes('Phone') ? [1, 0.1 * text.length] : [0.1 * text.length, 1]; },
    async topicModel(_set, _k, essays) {
      calls.topics++;
      return {
        topics: [{ label: 'Phones', keywords: ['phone'] }, { label: 'Uniforms', keywords: ['uniform'] }],
        assignments: Object.fromEntries(essays.map((e) => [e.tsvId, e.text.includes('Phone') ? 0 : 1])),
      };
    },
    ...overrides,
  };
  return { deps, calls };
}

async function process(sessionId: string, deps: CohortDeps) {
  const start = startCohortProcessing(sessionId, deps);
  if (start.status !== 'started') throw new Error(`expected a new run, got ${start.status}`);
  await start.finished;
  return getLatestRun(sessionId, 'cohort_processing', INSTANCE_ID)!;
}

describe('cohort processing', () => {
  it('stores summaries, topics and neighbours, and records a successful run', async () => {
    const sessionId = createTestSession(ESSAYS);
    const { deps } = fakeDeps();

    const run = await process(sessionId, deps);

    expect(run).toMatchObject({ status: 'success', expected_items: 4, processed_items: 4, failed_items: 0 });
    expect(getSession(sessionId)!.processing_status).toBe('complete');
    const essays = getEssaysBySession(sessionId);
    expect(essays.every((e) => e.summary?.startsWith('Summary of:'))).toBe(true);
    expect(getTopicsBySession(sessionId).map((t) => t.label)).toEqual(['Phones', 'Uniforms']);
    expect(essays.every((e) => e.topic_id !== null)).toBe(true);

    const a = essays.find((e) => e.filename === 'essay-A')!;
    expect(getSimilarEssays(sessionId, a.id)[0].filename).toBe('essay-B');
    expect(startCohortProcessing(sessionId, deps)).toEqual({ status: 'complete' });
  });

  it('reuses stored summaries and embeddings for unchanged essays, models and prompt', async () => {
    await process(createTestSession(ESSAYS), fakeDeps().deps);
    const { deps, calls } = fakeDeps();

    await process(createTestSession(ESSAYS), deps);

    expect(calls.summarise).toEqual([]);
    expect(calls.embed).toEqual([]);
  });

  it('recomputes only the essay whose text changed, although its dataset ID is the same', async () => {
    await process(createTestSession(ESSAYS), fakeDeps().deps);
    const { deps, calls } = fakeDeps();

    await process(createTestSession({ ...ESSAYS, C: 'School uniforms limit self-expression a lot.' }), deps);

    expect(calls.summarise).toEqual(['School uniforms limit self-expression a lot.']);
    expect(calls.embed).toEqual(['School uniforms limit self-expression a lot.']);
  });

  it('recomputes everything for another model', async () => {
    await process(createTestSession(ESSAYS), fakeDeps().deps);
    const { deps, calls } = fakeDeps({ summaryModel: 'other-chat', embeddingModel: 'other-embed' });

    await process(createTestSession(ESSAYS), deps);

    expect(calls.summarise).toHaveLength(4);
    expect(calls.embed).toHaveLength(4);
  });

  it('records a partial run when one essay fails, and a retry redoes only that essay', async () => {
    const sessionId = createTestSession({ ...ESSAYS, E: 'Phones break easily.' });
    const flaky = fakeDeps({
      async summarise(text) {
        if (text.includes('break')) throw new Error('model timed out');
        return `Summary of: ${text}`;
      },
    });

    const first = await process(sessionId, flaky.deps);
    expect(first).toMatchObject({ status: 'partial', expected_items: 5, processed_items: 4, failed_items: 1 });
    expect(first.error_message).toContain('summary failed for essay-E: model timed out');
    // The session completes, but the run records what's missing.
    expect(getSession(sessionId)!.processing_status).toBe('complete');

    const { deps, calls } = fakeDeps();
    const retry = await process(sessionId, deps);
    expect(retry.status).toBe('success');
    expect(calls.summarise).toEqual(['Phones break easily.']);
    expect(calls.topics).toBe(0); // topics already assigned
  });

  it("records the model's topics as history, so a teacher's move does not erase them", async () => {
    const sessionId = createTestSession(ESSAYS);
    await process(sessionId, fakeDeps().deps);
    const [phones, uniforms] = getTopicsBySession(sessionId);
    const a = getEssaysBySession(sessionId).find((e) => e.filename === 'essay-A')!;
    expect(a.topic_id).toBe(phones.id);

    assignTopic(sessionId, a.id, uniforms.id, 'manual');

    expect(getEssaysBySession(sessionId).find((e) => e.id === a.id)!.topic_id).toBe(uniforms.id);
    expect(getTopicAssignments(sessionId).filter((t) => t.essay_id === a.id).map((t) => [t.source, t.topic_id]))
      .toEqual([['model', phones.id], ['manual', uniforms.id]]);
  });

  it('stores which embedding model the similarities come from', async () => {
    const sessionId = createTestSession(ESSAYS);
    await process(sessionId, fakeDeps().deps);
    expect(getDb().prepare(`SELECT DISTINCT embedding_model, embedding_input_version
                            FROM essay_similarities WHERE session_id = ?`).all(sessionId))
      .toEqual([{ embedding_model: 'fake-embed', embedding_input_version: 'test' }]);
  });

  it("fails an essay whose embedding has a different number of dimensions than the model's others", async () => {
    const sessionId = createTestSession({ F: 'Phones ring.', G: 'Uniforms itch.', H: 'Phones die.', I: 'Uniforms fade.' });
    const { deps } = fakeDeps({
      embeddingModel: 'dims-embed',
      async embed(text) { return text === 'Phones die.' ? [1, 2, 3] : [text.length, 1]; },
    });

    const run = await process(sessionId, deps);

    expect(run).toMatchObject({ status: 'partial', processed_items: 3, failed_items: 1 });
    expect(run.error_message).toContain('embedding failed for essay-H: the model returned 3 dimensions, expected 2');
    // The other three still get neighbours.
    expect(getDb().prepare('SELECT COUNT(DISTINCT essay_id_a) AS n FROM essay_similarities WHERE session_id = ?').get(sessionId))
      .toEqual({ n: 3 });
  });

  it('checks new embeddings against the dimension already stored for the model', async () => {
    await process(createTestSession({ J: 'Phones buzz.', K: 'Uniforms fit.' }), fakeDeps({ embeddingModel: 'stored-embed' }).deps);
    const sessionId = createTestSession({ J: 'Phones buzz.', L: 'Uniforms shrink.' });

    const run = await process(sessionId, fakeDeps({ embeddingModel: 'stored-embed', async embed() { return [1, 2, 3]; } }).deps);

    expect(run.error_message).toContain('embedding failed for essay-L: the model returned 3 dimensions, expected 2');
  });

  it('fails the run when the topic model fails', async () => {
    const sessionId = createTestSession(ESSAYS);
    const { deps } = fakeDeps({ async topicModel() { throw new Error('python not found'); } });

    const run = await process(sessionId, deps);

    expect(run).toMatchObject({ status: 'failed', error_message: 'python not found' });
    expect(getSession(sessionId)!.processing_status).toBe('error');
  });

  it('keeps the failures found before the run stopped', async () => {
    // No models at all. New texts so cached summaries from earlier tests aren't used.
    const sessionId = createTestSession(Object.fromEntries(
      Object.entries(ESSAYS).map(([id, text]) => [id, `${text} (no models)`]),
    ));
    const { deps } = fakeDeps({
      async summarise() { throw new Error('Cannot reach Ollama'); },
      async topicModel() { throw new Error('python not found'); },
    });

    const run = await process(sessionId, deps);

    expect(run).toMatchObject({ status: 'failed', expected_items: 4, processed_items: 0, failed_items: 4 });
    expect(run.error_message).toMatch(/^python not found \(before that: summary failed for essay-A: Cannot reach Ollama/);
  });

  it('does not start a second run while one is in progress', async () => {
    const sessionId = createTestSession(ESSAYS);
    const { deps } = fakeDeps();

    const first = startCohortProcessing(sessionId, deps);
    expect(startCohortProcessing(sessionId, deps)).toEqual({ status: 'running' });
    if (first.status === 'started') await first.finished;
  });
});
