'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import type {
  Criterion,
  Assessment,
  Evidence,
  ContextItem,
  AssessmentType,
  AssessmentLength,
  HallucinationThreshold,
  OverallAssessmentResult,
  WorkflowStep,
  StudySession,
  EssayMeta,
} from '@/types';
import {
  gradeSingleCriterion,
} from '@/lib/llm-service';
import { sendJson, saveFailedMessage } from '@/lib/api-client';
import type { CsvRecorder } from '@/lib/csv-recorder';
import type { ActionLogger } from '@/lib/action-logger';

import InteractiveGrading from '@/components/grading/interactive-grading';
import CohortContextPanel from '@/components/cohort/cohort-context-panel';

interface SavedGrade {
  criterion_name: string;
  criterion_id: number;
  teacher_score: number | null;
  ai_score: number | null;
  original_ai_score: number | null;
  teacher_justification: string | null;
  ai_justification: string | null;
  evidence_json: string | null;
}

type PendingAction = 'auto-start' | { grades: SavedGrade[] } | null;

export interface GradingWorkspaceProps {
  recorder: CsvRecorder;
  actionLogger?: ActionLogger | null;
  studySession?: StudySession | null;
  preloadedRubric?: string;
  /** Criteria of the session's rubric, in grading order. */
  rubricCriteria: Criterion[];
  preloadedEssay?: EssayMeta | null;
  onBackToCohort?: () => void;
  onBackToList?: () => void;
  onBackToPreviousEssay?: () => void;
  previousEssayNumber?: number;
  onOpenEssay?: (essayId: string) => void;
  essayIndex?: number;
  totalEssays?: number;
  onEssayGraded?: (essayId: string, grade: number | null) => void;
  onLlmActiveChange?: (active: boolean) => void;
}

// Slide animation
const slideVariants = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.25 } },
  exit: { opacity: 0, x: -40, transition: { duration: 0.15 } },
};

export default function GradingWorkspace({
  recorder,
  actionLogger,
  studySession,
  preloadedRubric,
  rubricCriteria,
  preloadedEssay,
  onBackToCohort,
  onBackToList,
  onBackToPreviousEssay,
  previousEssayNumber,
  onOpenEssay,
  essayIndex,
  totalEssays,
  onEssayGraded,
  onLlmActiveChange,
}: GradingWorkspaceProps) {
  // 'loading' until the essay's saved grades have been fetched
  const [currentStep, setCurrentStep] = useState<WorkflowStep>('loading');

  // core data state
  const [essayFileName, setEssayFileName] = useState<string | null>(null);
  const [pdfContent, setPdfContent] = useState<string>('');
  const [rubricContent, setRubricContent] = useState<string>('');
  const [criteriaAssessments, setCriteriaAssessments] = useState<Record<string, Assessment>>({});

  // grading navigation state
  const [currentCriterionIndex, setCurrentCriterionIndex] = useState<number>(0);
  const [teacherScores, setTeacherScores] = useState<Record<string, number | null>>({});
  const [showAIScores, setShowAIScores] = useState<Record<string, boolean>>({});
  const [gradingComplete, setGradingComplete] = useState<boolean>(false);
  const [overallAssessment, setOverallAssessment] = useState<OverallAssessmentResult | null>(null);

  // settings state
  // Extra context for the grading prompt; no UI sets it at the moment.
  const [contextList] = useState<ContextItem[]>([]);
  const [assessmentType, setAssessmentType] = useState<AssessmentType>('flow');
  const assessmentLength: AssessmentLength = 'medium';
  // Logged in the research CSV; quote checking uses a fixed threshold (hallucination-utils.ts).
  const hallucinationThreshold: HallucinationThreshold = 'medium';

  // UI state
  const [isLlmActive, setIsLlmActive] = useState(false);

  // timing
  const [criterionStartTime, setCriterionStartTime] = useState<number | null>(null);

  // pdf evidence highlight

  // teacher justifications
  const [teacherJustifications, setTeacherJustifications] = useState<Record<string, string>>({});

  // hallucination tracking
  const [hallucinationCounts, setHallucinationCounts] = useState<
    Record<string, { detected: number; confirmed: number; reported: number }>
  >({});

  // pending action from grade fetch (restore or auto-start)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  // ref to prevent duplicate grading
  const gradingInProgress = useRef<Set<number>>(new Set());

  /* Sync LLM active state to parent */
  useEffect(() => {
    onLlmActiveChange?.(isLlmActive);
  }, [isLlmActive, onLlmActiveChange]);

  // ref to detect essay changes
  const prevEssayIdRef = useRef<string | null>(null);

  // Populate rubric from preloaded study data
  useEffect(() => {
    if (preloadedRubric) setRubricContent(preloadedRubric);
  }, [preloadedRubric]);

  // When the essay changes, reset state and restore saved grades
  useEffect(() => {
    if (!preloadedEssay) return;

    const isFirstMount = prevEssayIdRef.current === null;
    const isEssayChange = !isFirstMount && prevEssayIdRef.current !== preloadedEssay.id;
    prevEssayIdRef.current = preloadedEssay.id;

    setPdfContent(preloadedEssay.content);
    setEssayFileName(preloadedEssay.filename);

    if (isEssayChange) {
      // Reset grading state; keep rubricCriteria and settings
      setCriteriaAssessments({});
      setCurrentCriterionIndex(0);
      setTeacherScores({});
      setShowAIScores({});
      setGradingComplete(false);
      setOverallAssessment(null);
      setTeacherJustifications({});
      setHallucinationCounts({});
      setPendingAction(null);
      gradingInProgress.current.clear();
    }

    // In standalone mode (no session) keep the welcome-screen flow
    if (!studySession) return;

    let cancelled = false;

    fetch(`/api/sessions/${studySession.sessionId}/grades?essayId=${preloadedEssay.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const grades: SavedGrade[] = data.grades ?? [];
        if (grades.length > 0) {
          setPendingAction({ grades });
        } else {
          setPendingAction('auto-start');
        }
        setCurrentStep('grading');
      })
      .catch(() => {
        if (!cancelled) {
          setPendingAction('auto-start');
          setCurrentStep('grading');
        }
      });

    return () => { cancelled = true; };
  }, [preloadedEssay?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const gradeCurrentCriterion = useCallback(
    async (criteria: Criterion[], index: number) => {
      if (gradingInProgress.current.has(index)) return;
      gradingInProgress.current.add(index);
      setIsLlmActive(true);

      const criterion = criteria[index];
      if (!criterion) {
        gradingInProgress.current.delete(index);
        return;
      }

      try {
        const result = await gradeSingleCriterion(
          pdfContent,
          criterion,
          { assessmentType, assessmentLength },
          contextList,
          rubricContent,
        );

        const newAssessment: Assessment = {
          ...criterion,
          justification: result.justification,
          evidence: (result.evidence ?? []).map((e) => ({
            quote: e.quote,
            paragraph: e.paragraph,
            relatedAssessmentIndexes: e.relatedAssessmentIndexes,
          })),
          score: result.score ?? criterion.scoreRange.min,
          aiScore: result.score,
          originalAiScore: result.score,
          revisionRationale: null,
          revisedAssessmentText: null,
          error: result.error,
        };

        setCriteriaAssessments((prev) => ({
          ...prev,
          [criterion.name]: newAssessment,
        }));
      } catch (err) {
        console.error(`Error grading criterion "${criterion.name}":`, err);
        throw err;
      } finally {
        gradingInProgress.current.delete(index);
        if (gradingInProgress.current.size === 0) setIsLlmActive(false);
      }
    },
    [pdfContent, rubricContent, contextList, assessmentType, assessmentLength],
  );

  // Process pending action once pdfContent is ready
  useEffect(() => {
    if (!pendingAction || !pdfContent) return;

    if (pendingAction === 'auto-start') {
      setPendingAction(null);
      setCurrentCriterionIndex(0);
      setCriterionStartTime(Date.now());
      actionLogger?.log('ai_grading_started', { essayId: preloadedEssay?.id });
      gradeCurrentCriterion(rubricCriteria, 0)
        .then(() => actionLogger?.log('ai_grading_complete', { essayId: preloadedEssay?.id }))
        .catch(console.error);
    } else {
      // Restore grades from saved data
      const grades = pendingAction.grades;
      setPendingAction(null);

      const restoredAssessments: Record<string, Assessment> = {};
      const restoredTeacherScores: Record<string, number | null> = {};
      const restoredShowAI: Record<string, boolean> = {};
      const restoredTeacherJustifications: Record<string, string> = {};

      for (const g of grades) {
        const criterion = rubricCriteria.find((c) => c.name === g.criterion_name);
        if (!criterion) continue;

        const justText = g.ai_justification ?? '';
        const justification: string | string[] =
          justText.includes('\n') ? justText.split('\n').filter(Boolean) : justText;

        let evidence: Evidence[] = [];
        if (g.evidence_json) {
          try { evidence = JSON.parse(g.evidence_json); } catch { /* ignore */ }
        }

        restoredAssessments[g.criterion_name] = {
          ...criterion,
          justification,
          evidence,
          score: g.ai_score ?? criterion.scoreRange.min,
          aiScore: g.ai_score,
          originalAiScore: g.original_ai_score,
          revisionRationale: null,
          revisedAssessmentText: null,
        };

        restoredTeacherScores[g.criterion_name] = g.teacher_score ?? null;
        if (g.teacher_score !== null) restoredShowAI[g.criterion_name] = true;
        if (g.teacher_justification) restoredTeacherJustifications[g.criterion_name] = g.teacher_justification;
      }

      setCriteriaAssessments(restoredAssessments);
      setTeacherScores(restoredTeacherScores);
      setShowAIScores(restoredShowAI);
      setTeacherJustifications(restoredTeacherJustifications);
      setCurrentCriterionIndex(0);
      setCriterionStartTime(Date.now());
      actionLogger?.log('grades_restored', { essayId: preloadedEssay?.id, count: grades.length });
    }
  }, [pendingAction, pdfContent, gradeCurrentCriterion, actionLogger, preloadedEssay?.id, rubricCriteria]);


  const handleTeacherScoreInput = useCallback((criterionId: string, score: number) => {
    setTeacherScores((prev) => ({ ...prev, [criterionId]: score }));
    actionLogger?.log('teacher_score_assigned', { criterionId, score }, preloadedEssay?.id);
  }, [actionLogger, preloadedEssay?.id]);

  const revealAIScore = useCallback((criterionId: string) => {
    setShowAIScores((prev) => ({ ...prev, [criterionId]: true }));
  }, []);

  const handleTeacherJustificationInput = useCallback((criterionId: string, text: string) => {
    setTeacherJustifications((prev) => ({ ...prev, [criterionId]: text }));
    actionLogger?.log('teacher_justification_written', { criterionId }, preloadedEssay?.id);
  }, [actionLogger, preloadedEssay?.id]);

  // Saves a grade. Throws if the server didn't store it, so the caller can stay on this
  // criterion and show an error.
  const persistGrade = useCallback(async (
    criterion: { id: number; name: string },
    assessment: Assessment,
    teacherScore: number | null,
    teacherJustification: string,
  ) => {
    if (!studySession || !preloadedEssay) return;
    const justText = Array.isArray(assessment.justification)
      ? assessment.justification.join('\n')
      : assessment.justification;
    try {
      await sendJson(`/api/sessions/${studySession.sessionId}/grades`, 'POST', {
        essayId: preloadedEssay.id,
        criterionName: criterion.name,
        criterionId: criterion.id,
        teacher_score: teacherScore,
        ai_score: assessment.aiScore ?? null,
        original_ai_score: assessment.originalAiScore ?? null,
        teacher_justification: teacherJustification || null,
        ai_justification: justText || null,
        evidence_json: assessment.evidence?.length ? JSON.stringify(assessment.evidence) : null,
      });
    } catch (err) {
      throw new Error(saveFailedMessage(`Grade for "${criterion.name}"`, err));
    }
  }, [studySession, preloadedEssay]);

  // DC: mark the current essay as the benchmark for this criterion
  const handleSetBenchmark = useCallback(async () => {
    if (!studySession || !preloadedEssay) return;
    const criterion = rubricCriteria[currentCriterionIndex];
    if (!criterion) return;
    const score = teacherScores[criterion.name];
    if (score === null || score === undefined) return;

    try {
      await sendJson(`/api/sessions/${studySession.sessionId}/benchmarks`, 'POST', {
        criterionName: criterion.name,
        essayId: preloadedEssay.id,
        type: String(score),
        score,
      });
    } catch (err) {
      throw new Error(saveFailedMessage('Benchmark', err));
    }
    actionLogger?.log('benchmark_set', { criterionName: criterion.name, type: String(score) }, preloadedEssay.id);
  }, [studySession, preloadedEssay, rubricCriteria, currentCriterionIndex, teacherScores, actionLogger]);

  const moveToNextCriterion = useCallback(async () => {
    const criterion = rubricCriteria[currentCriterionIndex];
    if (!criterion) return;

    const assessment = criteriaAssessments[criterion.name];

    // Save first; if that throws, nothing below is recorded or logged.
    if (assessment) {
      await persistGrade(criterion, assessment, teacherScores[criterion.name] ?? null, teacherJustifications[criterion.name] ?? '');
    }

    if (assessment && recorder) {
      const elapsedMs = criterionStartTime ? Date.now() - criterionStartTime : 0;
      const hCounts = hallucinationCounts[criterion.name] ?? { detected: 0, confirmed: 0, reported: 0 };
      const tScore = teacherScores[criterion.name] ?? null;
      const aScore = assessment.aiScore;
      recorder.addGradeRecord({
        essay_id: essayFileName || '',
        criterion_name: criterion.name,
        criterion_id: String(criterion.id),
        score_min: criterion.scoreRange.min,
        score_max: criterion.scoreRange.max,
        teacher_score: tScore,
        ai_score: aScore,
        revised_ai_score: assessment.originalAiScore !== aScore ? aScore : null,
        score_difference: tScore !== null && aScore !== null ? tScore - aScore : null,
        assessment_type: assessmentType,
        assessment_length: assessmentLength,
        hallucination_threshold: hallucinationThreshold,
        evidence_count: assessment.evidence?.length ?? 0,
        time_spent_seconds: Math.round(elapsedMs / 1000),
        hallucinations_detected: hCounts.detected,
        hallucinations_confirmed: hCounts.confirmed,
        hallucinations_reported: hCounts.reported,
        action_type: 'grade',
        assessment_was_edited: assessment.revisedAssessmentText !== null,
        original_ai_score: assessment.originalAiScore,
        edited_justification_text: assessment.revisedAssessmentText ?? null,
      });
    }

    actionLogger?.log('grade_submitted', { criterionName: criterion.name }, preloadedEssay?.id);

    const nextIndex = currentCriterionIndex + 1;
    if (nextIndex >= rubricCriteria.length) return;

    setCurrentCriterionIndex(nextIndex);
    setCriterionStartTime(Date.now());

    const nextCriterion = rubricCriteria[nextIndex];
    if (nextCriterion && !criteriaAssessments[nextCriterion.name]) {
      gradeCurrentCriterion(rubricCriteria, nextIndex);
    }
  }, [
    rubricCriteria,
    currentCriterionIndex,
    criteriaAssessments,
    recorder,
    criterionStartTime,
    teacherScores,
    essayFileName,
    gradeCurrentCriterion,
    hallucinationCounts,
    assessmentType,
    assessmentLength,
    hallucinationThreshold,
    actionLogger,
    preloadedEssay?.id,
    persistGrade,
    teacherJustifications,
  ]);

  const moveToPreviousCriterion = useCallback(() => {
    if (currentCriterionIndex <= 0) return;
    setCurrentCriterionIndex((prev) => prev - 1);
    setCriterionStartTime(Date.now());
  }, [currentCriterionIndex]);

  const finishGrading = useCallback(async () => {
    const criterion = rubricCriteria[currentCriterionIndex];

    // Save the last grade first; on failure this throws and the essay is not marked graded.
    const lastAssessment = criterion ? criteriaAssessments[criterion.name] : undefined;
    if (criterion && lastAssessment) {
      await persistGrade(criterion, lastAssessment, teacherScores[criterion.name] ?? null, teacherJustifications[criterion.name] ?? '');
    }

    if (criterion) {
      const assessment = criteriaAssessments[criterion.name];
      if (assessment && recorder) {
        const elapsedMs = criterionStartTime ? Date.now() - criterionStartTime : 0;
        const hCounts = hallucinationCounts[criterion.name] ?? { detected: 0, confirmed: 0, reported: 0 };
        const tScore = teacherScores[criterion.name] ?? null;
        const aScore = assessment.aiScore;
        recorder.addGradeRecord({
          essay_id: essayFileName || '',
          criterion_name: criterion.name,
          criterion_id: String(criterion.id),
          score_min: criterion.scoreRange.min,
          score_max: criterion.scoreRange.max,
          teacher_score: tScore,
          ai_score: aScore,
          revised_ai_score: assessment.originalAiScore !== aScore ? aScore : null,
          score_difference: tScore !== null && aScore !== null ? tScore - aScore : null,
          assessment_type: assessmentType,
          assessment_length: assessmentLength,
          hallucination_threshold: hallucinationThreshold,
          evidence_count: assessment.evidence?.length ?? 0,
          time_spent_seconds: Math.round(elapsedMs / 1000),
          hallucinations_detected: hCounts.detected,
          hallucinations_confirmed: hCounts.confirmed,
          hallucinations_reported: hCounts.reported,
          action_type: 'grade',
          assessment_was_edited: assessment.revisedAssessmentText !== null,
          original_ai_score: assessment.originalAiScore,
          edited_justification_text: assessment.revisedAssessmentText ?? null,
        });
      }
    }

    const tScores = rubricCriteria
      .map((c) => teacherScores[c.name])
      .filter((s): s is number => s != null);
    const avgGrade = tScores.length > 0
      ? Math.round((tScores.reduce((sum, s) => sum + s, 0) / tScores.length) * 10) / 10
      : null;

    const scoreSummary = rubricCriteria
      .map((c) => {
        const ts = teacherScores[c.name];
        const as = criteriaAssessments[c.name]?.aiScore;
        return `${c.name}: ${ts ?? as ?? '—'}/${c.scoreRange.max}`;
      })
      .join(', ');

    const overall: OverallAssessmentResult = {
      strengths: 'Grading complete. Review individual criterion assessments for detailed feedback.',
      improvements: 'Refer to the criterion-level justifications for specific areas to improve.',
      overallGrade: avgGrade ?? '—',
      advice: `Scores — ${scoreSummary}`,
    };

    if (studySession && preloadedEssay) {
      try {
        await sendJson(`/api/sessions/${studySession.sessionId}/essays/${preloadedEssay.id}`, 'PATCH', {
          grading_status: 'graded',
          overall_grade: avgGrade,
        });
      } catch (err) {
        throw new Error(saveFailedMessage('Essay completion', err));
      }
      onEssayGraded?.(preloadedEssay.id, avgGrade ?? null);
    }

    setOverallAssessment(overall);
    setGradingComplete(true);
    setCurrentStep('complete');
    actionLogger?.log('all_grades_submitted', { essayId: preloadedEssay?.id });
  }, [
    rubricCriteria,
    currentCriterionIndex,
    criteriaAssessments,
    recorder,
    criterionStartTime,
    teacherScores,
    teacherJustifications,
    essayFileName,
    hallucinationCounts,
    assessmentType,
    assessmentLength,
    hallucinationThreshold,
    actionLogger,
    preloadedEssay,
    studySession,
    persistGrade,
    onEssayGraded,
  ]);

  // Leave the summary and go back to the per-criterion view
  const backToGrading = useCallback(() => {
    setGradingComplete(false);
  }, []);

  const updateHallucinationCounts = useCallback(
    (criterionName: string, counts: { detected: number; confirmed: number; reported: number }) => {
      setHallucinationCounts((prev) => {
        const existing = prev[criterionName] ?? { detected: 0, confirmed: 0, reported: 0 };
        return {
          ...prev,
          [criterionName]: {
            detected: counts.detected || existing.detected,
            confirmed: counts.confirmed || existing.confirmed,
            reported: existing.reported + (counts.reported || 0),
          },
        };
      });
    },
    [],
  );

  return (
    <div className="relative flex h-full w-full flex-col" style={{ background: 'var(--background)' }}>
      <div className="flex flex-1 flex-col overflow-y-auto">
        <AnimatePresence mode="wait">
          {currentStep === 'loading' && (
            <motion.div key="loading" {...slideVariants} className="flex flex-1 items-center justify-center p-8">
              <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading essay…</p>
            </motion.div>
          )}

          {/* Grading and summary */}
          {(currentStep === 'grading' || currentStep === 'complete') && (
            <motion.div key="grading" {...slideVariants} className="flex h-full flex-1 flex-col overflow-hidden">
              {/* Header bar: back button + essay info */}
              {preloadedEssay && (
                <div
                  className="flex shrink-0 items-center gap-3 border-b border-[var(--card-border)] px-4 py-2"
                  style={{ background: 'var(--background)' }}
                >
                  {onBackToPreviousEssay ? (
                    <button
                      onClick={isLlmActive ? undefined : onBackToPreviousEssay}
                      disabled={isLlmActive}
                      title={isLlmActive ? 'Wait for AI to finish grading' : undefined}
                      className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ color: 'var(--muted)', cursor: isLlmActive ? 'not-allowed' : 'pointer' }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Essay {previousEssayNumber}
                    </button>
                  ) : onBackToCohort ? (
                    <button
                      onClick={isLlmActive ? undefined : onBackToCohort}
                      disabled={isLlmActive}
                      title={isLlmActive ? 'Wait for AI to finish grading' : undefined}
                      className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ color: 'var(--muted)', cursor: isLlmActive ? 'not-allowed' : 'pointer' }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Cohort
                    </button>
                  ) : onBackToList ? (
                    <button
                      onClick={isLlmActive ? undefined : onBackToList}
                      disabled={isLlmActive}
                      title={isLlmActive ? 'Wait for AI to finish grading' : undefined}
                      className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ color: 'var(--muted)', cursor: isLlmActive ? 'not-allowed' : 'pointer' }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      List
                    </button>
                  ) : null}
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                      {preloadedEssay.filename}
                    </span>
                    {essayIndex != null && totalEssays != null && (
                      <span className="shrink-0 rounded bg-[var(--card-bg)] px-2 py-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                        {essayIndex + 1} / {totalEssays}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div className="flex min-w-0 flex-1 overflow-hidden">
              <div className="min-w-0 flex-1 overflow-hidden">
                <InteractiveGrading
                  pdfContent={pdfContent}
                  essayPrompt={preloadedEssay?.prompt ?? null}
                  rubricCriteria={rubricCriteria}
                  criteriaAssessments={criteriaAssessments}
                  currentCriterionIndex={currentCriterionIndex}
                  teacherScores={teacherScores}
                  showAIScores={showAIScores}
                  assessmentType={assessmentType}
                  gradingComplete={gradingComplete}
                  overallAssessment={overallAssessment}
                  handleTeacherScoreInput={handleTeacherScoreInput}
                  revealAIScore={revealAIScore}
                  moveToNextCriterion={moveToNextCriterion}
                  moveToPreviousCriterion={moveToPreviousCriterion}
                  finishGrading={finishGrading}
                  gradeCurrentCriterion={gradeCurrentCriterion}
                  setCriteriaAssessments={setCriteriaAssessments}
                  setAssessmentType={setAssessmentType}
                  teacherJustifications={teacherJustifications}
                  onTeacherJustificationChange={handleTeacherJustificationInput}
                  onRevisitCriteria={backToGrading}
                  onBackToCohort={onBackToCohort}
                  onBackToList={onBackToList}
                  onHallucinationUpdate={updateHallucinationCounts}
                  onSetBenchmark={studySession?.condition === 'dashboard' ? handleSetBenchmark : undefined}
                  actionLogger={actionLogger}
                  essayId={preloadedEssay?.id ?? null}
                  sessionId={studySession?.sessionId ?? null}
                />
              </div>

              {/* DC-only cohort context sidebar */}
              {studySession?.condition === 'dashboard' && currentStep === 'grading' && preloadedEssay && (
                <CohortContextPanel
                  sessionId={studySession.sessionId}
                  essayId={preloadedEssay.id}
                  criterionName={rubricCriteria[currentCriterionIndex]?.name ?? null}
                  currentAssessment={(() => {
                    const name = rubricCriteria[currentCriterionIndex]?.name;
                    const a = name ? criteriaAssessments[name] : undefined;
                    return a ? { justification: a.justification, aiScore: a.aiScore } : null;
                  })()}
                  actionLogger={actionLogger}
                  onOpenEssay={onOpenEssay}
                  disableEssayOpen={isLlmActive}
                />
              )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
