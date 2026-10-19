// Runs python/topic_model.py: JSON job on stdin, JSON result on stdout, progress on stderr.
// Handles the timeout, the exit code and validation of the result.

import { spawn } from 'child_process';
import { OLLAMA_BASE_URL } from './ollama';

export const TOPIC_EMBED_MODEL = process.env.TOPIC_EMBED_MODEL || 'BAAI/bge-large-en-v1.5';
export const TOPIC_LLM_MODEL = process.env.TOPIC_LLM_MODEL || 'gemma2:9b';

const PYTHON_BIN = process.env.TOPIC_PYTHON || 'python';
// The first run downloads BGE (~1.3 GB) and loads gemma2:9b, hence the long timeout.
const TIMEOUT_MS = Number(process.env.TOPIC_MODEL_TIMEOUT_MS) || 15 * 60_000;
// Relative to the project root, which is the working directory of the server and the child process.
const SCRIPT_PATH = 'python/topic_model.py';

export interface TopicJob {
  essaySet: string;
  k: number;
  essays: { tsvId: string; text: string }[];
}

export interface TopicScriptResult {
  topics: { label: string; keywords: string[] }[];
  /** tsv_id -> topic index */
  assignments: Record<string, number>;
  /** Keyword preprocessing the script used: "spacy-lemma" or "sklearn-stopwords". */
  preprocessing: string | null;
}

export function runTopicScript(job: TopicJob): Promise<TopicScriptResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_BIN,
      [SCRIPT_PATH, '--embed-model', TOPIC_EMBED_MODEL, '--llm-model', TOPIC_LLM_MODEL, '--ollama-url', OLLAMA_BASE_URL],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } },
    );

    let stdout = '';
    let lastError = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`topic model timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        console.log('[topics:py]', line);
        if (line.includes('FAILED')) lastError = line;
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start "${PYTHON_BIN}": ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(lastError || `topic model exited with code ${code}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`topic model returned invalid JSON: ${stdout.slice(0, 200)}`));
        return;
      }
      try {
        resolve(parseTopicResult(parsed, job));
      } catch (err) {
        reject(err);
      }
    });

    proc.stdin.end(JSON.stringify({
      essay_set: job.essaySet,
      k: job.k,
      essays: job.essays.map((e) => ({ id: e.tsvId, text: e.text })),
    }));
  });
}

/** Checks the output: at most k topics with a label and keywords, and every essay assigned to one. */
export function parseTopicResult(raw: unknown, job: TopicJob): TopicScriptResult {
  const fail = (why: string): never => { throw new Error(`topic model returned an unusable result: ${why}`); };
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const { topics, assignments, meta } = raw as { topics?: unknown; assignments?: unknown; meta?: { preprocessing?: unknown } };

  if (!Array.isArray(topics) || topics.length === 0 || topics.length > job.k) {
    fail(`expected 1 to ${job.k} topics`);
  }
  const topicList = topics as unknown[];
  topicList.forEach((t, i) => {
    const topic = t as { label?: unknown; keywords?: unknown };
    if (typeof topic?.label !== 'string' || !topic.label.trim()) fail(`topic ${i} has no label`);
    if (!Array.isArray(topic.keywords) || !topic.keywords.every((w) => typeof w === 'string')) {
      fail(`topic ${i} has no keyword list`);
    }
  });

  if (typeof assignments !== 'object' || assignments === null) fail('no assignments');
  const assigned = assignments as Record<string, unknown>;
  const missing = job.essays.filter((e) => !(e.tsvId in assigned)).map((e) => e.tsvId);
  if (missing.length > 0) fail(`${missing.length} essay(s) have no topic (${missing.slice(0, 5).join(', ')})`);
  for (const [id, index] of Object.entries(assigned)) {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= topicList.length) {
      fail(`essay ${id} is assigned to topic ${String(index)}, which does not exist`);
    }
  }

  return {
    topics: topicList as TopicScriptResult['topics'],
    assignments: assigned as Record<string, number>,
    preprocessing: typeof meta?.preprocessing === 'string' ? meta.preprocessing : null,
  };
}
