// AI grading precompute, started by POST /api/sessions/[id]/precompute and run in the
// background. Each run is recorded in pipeline_runs.
//
// For each essay x criterion without an AI score: reuse a cached successful assessment (if
// the session allows it) or ask the model, validate the reply and save it. Failures are
// stored but never reused, so the next run retries them. grades_precomputed is only set
// when every item succeeded.

import type { Criterion } from '@/types';
import { assessmentKey, contentHash, runInputHash } from '@/lib/cache-key';
import { GRADING_PROMPT_VERSION, criterionHash, gradeCriterion } from '@/server/services/llm-grading';
import { logAction } from '@/server/db/action-logs';
import { getAssessment, saveAssessmentFailure, saveAssessmentSuccess, type AssessmentInputs } from '@/server/db/caches';
import { getDb } from '@/server/db/client';
import { computeQualityRanks, datasetId, getEssaysBySession, updateEssayAiQuality, type Essay } from '@/server/db/essays';
import { getGradeForCriterion, upsertGrade } from '@/server/db/grades';
import { getRubricCriteria } from '@/server/db/rubrics';
import {
  finishRun, getLatestRun, outcomeStatus, recordRunItem, startRun, type PipelineRun,
} from '@/server/db/pipeline-runs';
import { getSession, markGradesPrecomputed, type Session } from '@/server/db/sessions';
import { INSTANCE_ID } from '@/server/instance';
import { OLLAMA_MODEL } from '@/server/integrations/ollama';
import { validateAssessment, type UsableAssessment } from '@/server/validation/model-output';

// Per-criterion timeout. 180 s is enough for a 7-8B model on a 4 GB GPU; raise it via env if needed.
const LLM_TIMEOUT_MS = Number(process.env.LLM_PRECOMPUTE_TIMEOUT_MS) || 180_000;

export interface GradeInput {
  essayContent: string;
  criterion: Criterion;
  assessmentType: string;
  assessmentLength: string;
}

/** Model calls used by the pipeline; tests pass fakes. */
export interface PrecomputeDeps {
  model: string;
  timeoutMs: number;
  /** Defaults to the criteria of the session's rubric. */
  criteria?: Criterion[];
  /** Returns the parsed model reply (validated afterwards). */
  grade(input: GradeInput, signal: AbortSignal): Promise<unknown>;
}

const defaultPrecomputeDeps: PrecomputeDeps = {
  model: OLLAMA_MODEL,
  timeoutMs: LLM_TIMEOUT_MS,
  grade: (input, signal) => gradeCriterion({ ...input, contextList: [] }, { signal }),
};

export type PrecomputeStart =
  | { status: 'not_found' }
  | { status: 'skipped' }
  | { status: 'complete' }
  | { status: 'running' }
  | { status: 'started'; finished: Promise<void> };

export function startGradingPrecompute(sessionId: string, deps: PrecomputeDeps = defaultPrecomputeDeps): PrecomputeStart {
  const session = getSession(sessionId);
  if (!session) return { status: 'not_found' };
  if (!session.precompute_grades) return { status: 'skipped' };
  if (session.grades_precomputed) return { status: 'complete' };

  const essays = getEssaysBySession(sessionId);
  const criteria = deps.criteria ?? getRubricCriteria(session.rubric_id);
  const config = {
    model: deps.model,
    promptVersion: GRADING_PROMPT_VERSION,
    rubricId: session.rubric_id,
    criteria: criteria.map((c) => ({ id: c.id, hash: criterionHash(c) })),
    assessmentType: session.assessment_type,
    assessmentLength: session.assessment_length,
    reuseStoredAssessments: session.use_cached_assessments === 1,
  };
  const start = startRun({
    sessionId,
    type: 'grading_precompute',
    instanceId: INSTANCE_ID,
    inputHash: runInputHash(essays.map((e) => ({ id: datasetId(e), text: e.pdf_content })), config),
    config,
    expectedItems: essays.length * criteria.length,
  });
  if ('alreadyRunning' in start) return { status: 'running' };

  return { status: 'started', finished: runPrecompute(session, essays, criteria, start.started.id, deps) };
}

export function getPrecomputeStatus(session: Session): { grades_precomputed: boolean; running: boolean; run: PipelineRun | null } {
  const run = getLatestRun(session.id, 'grading_precompute', INSTANCE_ID);
  return { grades_precomputed: session.grades_precomputed === 1, running: run?.status === 'running', run };
}

async function runPrecompute(
  session: Session,
  essays: Essay[],
  criteria: Criterion[],
  runId: number,
  deps: PrecomputeDeps,
): Promise<void> {
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    for (const essay of essays) {
      for (const criterion of criteria) {
        const outcome = await precomputeItem(session, essay, criterion, deps);
        recordRunItem(runId, outcome.ok ? 'processed' : 'failed');
        if (outcome.ok) {
          processed++;
        } else {
          failed++;
          errors.push(`${essay.filename} / ${criterion.name}: ${outcome.error}`);
          console.warn(`[precompute] ${errors.at(-1)}`);
        }
      }
      // Rank snapshot for the research log (shown in the rank-history chart).
      logAction(session.id, session.participant_id, session.condition, session.essay_set,
        'quality_rank_updated', undefined, computeQualityRanks(session.id));
    }

    const status = outcomeStatus(processed, failed);
    finishRun(runId, status, errors.length ? `${failed} failed: ${errors.slice(0, 3).join('; ')}` : null);
    if (status === 'success') markGradesPrecomputed(session.id);
    console.log(`[precompute] ${status}: ${processed} done, ${failed} failed, session ${session.id}`);
  } catch (err) {
    console.error('[precompute] run failed:', err);
    finishRun(runId, 'failed', err instanceof Error ? err.message : String(err));
  }
}

async function precomputeItem(
  session: Session,
  essay: Essay,
  criterion: Criterion,
  deps: PrecomputeDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Already scored by an earlier run or by interactive grading.
  const existing = getGradeForCriterion(session.id, essay.id, criterion.id);
  if (existing?.ai_score != null) return { ok: true };

  const identity = {
    contentHash: contentHash(essay.pdf_content),
    criterionHash: criterionHash(criterion),
    model: deps.model,
    promptVersion: GRADING_PROMPT_VERSION,
    assessmentType: session.assessment_type,
    assessmentLength: session.assessment_length,
  };
  const inputs: AssessmentInputs = { key: assessmentKey(identity), criterionId: criterion.id, ...identity };

  let assessment: UsableAssessment;
  const stored = session.use_cached_assessments ? getAssessment(inputs.key) : null;
  if (stored?.status === 'success') {
    assessment = { score: stored.score!, justification: stored.justification!, evidenceJson: stored.evidence_json ?? '[]' };
  } else {
    try {
      const reply = await deps.grade(
        { essayContent: essay.pdf_content, criterion, assessmentType: session.assessment_type, assessmentLength: session.assessment_length },
        AbortSignal.timeout(deps.timeoutMs),
      );
      const checked = validateAssessment(reply, criterion);
      if (!checked.ok) throw new Error(checked.error);
      assessment = checked.value;
      saveAssessmentSuccess(inputs, assessment);
    } catch (err) {
      const error = err instanceof Error && err.name === 'TimeoutError'
        ? `no reply within ${deps.timeoutMs / 1000}s`
        : err instanceof Error ? err.message : String(err);
      saveAssessmentFailure(inputs, error);
      return { ok: false, error };
    }
  }

  // Update the grade and the essay's average AI score together.
  getDb().transaction(() => {
    upsertGrade(session.id, essay.id, criterion.id, {
      ai_score: assessment.score,
      original_ai_score: assessment.score,
      ai_justification: assessment.justification,
      evidence_json: assessment.evidenceJson,
    });
    updateEssayAiQuality(essay.id, session.id);
  })();
  return { ok: true };
}
