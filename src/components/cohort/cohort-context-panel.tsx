'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, X, BarChart2 } from 'lucide-react';
import type { ActionLogger } from '@/lib/action-logger';
import { sendJson, saveFailedMessage } from '@/lib/api-client';
import BenchmarkComparisonModal from '@/components/cohort/benchmark-comparison-modal';
import InfoTooltip from '@/components/ui/info-tooltip';

interface SimilarEssay {
  essay_id: string;
  filename: string;
  similarity_score: number;
  grading_status: string;
  overall_grade: number | null;
  summary: string | null;
}

interface BenchmarkEntry {
  id: number;
  essay_id: string;
  benchmark_type: string;
  score: number;
  filename: string | null;
  summary: string | null;
}

export interface CurrentAssessment {
  justification: string | string[];
  aiScore: number | null;
}

interface CohortContextPanelProps {
  sessionId: string;
  essayId: string;
  criterionName: string | null;
  currentAssessment?: CurrentAssessment | null;
  actionLogger?: ActionLogger | null;
  onOpenEssay?: (essayId: string) => void;
  disableEssayOpen?: boolean;
}

export default function CohortContextPanel({
  sessionId,
  essayId,
  criterionName,
  currentAssessment,
  actionLogger,
  onOpenEssay,
  disableEssayOpen,
}: CohortContextPanelProps) {
  // Each list is stored with the key it was fetched for; a stale or missing key means loading.
  const similarKey = `${sessionId}/${essayId}`;
  const benchmarkKey = criterionName ? `${sessionId}/${criterionName}` : null;
  const [similarFor,    setSimilarFor]    = useState<{ key: string; list: SimilarEssay[] } | null>(null);
  const [benchmarksFor, setBenchmarksFor] = useState<{ key: string; list: BenchmarkEntry[] } | null>(null);
  const [benchmarkError,    setBenchmarkError]    = useState<string | null>(null);
  const [expandedId,        setExpandedId]        = useState<string | null>(null);
  const [showComparison,    setShowComparison]    = useState(false);

  const loadingSimilar = similarFor?.key !== similarKey;
  const similar = loadingSimilar ? [] : similarFor.list;
  const loadingBenchmarks = benchmarkKey !== null && benchmarksFor?.key !== benchmarkKey;
  const benchmarks = benchmarkKey !== null && benchmarksFor?.key === benchmarkKey ? benchmarksFor.list : [];

  // Criterion changed: clear the error and close the comparison (set during render, not in an effect).
  const [shownBenchmarkKey, setShownBenchmarkKey] = useState(benchmarkKey);
  if (shownBenchmarkKey !== benchmarkKey) {
    setShownBenchmarkKey(benchmarkKey);
    setBenchmarkError(null);
    setShowComparison(false);
  }

  /* Fetch similar essays when essay changes */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/essays/${essayId}/similar`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setSimilarFor({ key: similarKey, list: data.similar ?? [] }); })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setSimilarFor({ key: similarKey, list: [] });
      });
    return () => { cancelled = true; };
  }, [sessionId, essayId, similarKey]);

  /* Fetch benchmarks when criterion changes */
  useEffect(() => {
    if (!criterionName || !benchmarkKey) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/benchmarks?criterion=${encodeURIComponent(criterionName)}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setBenchmarksFor({ key: benchmarkKey, list: data.benchmarks ?? [] }); })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setBenchmarksFor({ key: benchmarkKey, list: [] });
      });
    return () => { cancelled = true; };
  }, [sessionId, criterionName, benchmarkKey]);

  const removeBenchmarkEntry = useCallback(
    async (type: string) => {
      if (!criterionName) return;
      setBenchmarkError(null);
      try {
        await sendJson(`/api/sessions/${sessionId}/benchmarks`, 'DELETE', { criterionName, type });
      } catch (err) {
        setBenchmarkError(saveFailedMessage('Benchmark removal', err));
        return;
      }
      actionLogger?.log('benchmark_removed', { criterionName, type });
      setBenchmarksFor((prev) => prev && { ...prev, list: prev.list.filter((b) => b.benchmark_type !== type) });
    },
    [sessionId, criterionName, actionLogger],
  );

  const sortedBenchmarks = [...benchmarks].sort((a, b) => Number(a.benchmark_type) - Number(b.benchmark_type));

  return (
    <>
      <div
        className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-[var(--card-border)]"
        style={{ background: 'var(--background)', height: 'calc(100vh - 4rem)' }}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 shrink-0 border-b border-[var(--card-border)] px-4 py-3"
          style={{ background: 'var(--background)' }}
        >
          <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Cohort Context
          </h3>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
            DC — additional essay context
          </p>
        </div>

        {/* Similar essays */}
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              Similar Essays
              <InfoTooltip
                side="bottom"
                align="end"
                text="Each essay is converted to a vector using the nomic-embed-text model. The percentage is the cosine similarity (0–100%) between this essay and another in the cohort — higher means more semantically similar wording and ideas."
              />
            </span>
            {loadingSimilar && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--muted)' }} />
            )}
          </div>

          {!loadingSimilar && similar.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              No similar essays in cohort yet.
            </p>
          ) : (
            <div className="space-y-2">
              {similar.map((essay) => {
                const simPct   = Math.round(essay.similarity_score * 100);
                const expanded = expandedId === essay.essay_id;

                return (
                  <div
                    key={essay.essay_id}
                    className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)]"
                  >
                    {/* Summary row */}
                    <button
                      className="w-full cursor-pointer p-3 text-left"
                      onClick={() => {
                        const next = expanded ? null : essay.essay_id;
                        setExpandedId(next);
                        if (next) {
                          actionLogger?.log(
                            'similar_essay_viewed',
                            { similarity: essay.similarity_score },
                            essay.essay_id,
                          );
                        }
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-xs font-medium" style={{ color: 'var(--foreground)' }}>
                          {essay.filename}
                        </span>
                        <span className="shrink-0 text-xs font-bold text-indigo-500">
                          {simPct}%
                        </span>
                      </div>

                      <div
                        className="mt-1.5 h-1 overflow-hidden rounded-full"
                        style={{ background: 'var(--card-border)' }}
                      >
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          style={{ width: `${simPct}%` }}
                        />
                      </div>

                      <div className="mt-1.5 flex items-center gap-2">
                        <span
                          className={`text-[10px] ${essay.grading_status === 'graded' ? 'text-emerald-500' : ''}`}
                          style={essay.grading_status !== 'graded' ? { color: 'var(--muted)' } : {}}
                        >
                          {essay.grading_status === 'graded' ? '✓ Graded' : 'Not graded'}
                        </span>
                        {essay.overall_grade !== null && (
                          <span className="rounded bg-indigo-500/10 px-1 py-0.5 text-[10px] font-bold text-indigo-500">
                            {essay.overall_grade}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded content */}
                    {expanded && (
                      <div className="space-y-2 border-t border-[var(--card-border)] p-3 pt-2">
                        {essay.summary && (
                          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                            {essay.summary}
                          </p>
                        )}
                        {onOpenEssay && (
                          <button
                            onClick={() => {
                              if (disableEssayOpen) return;
                              actionLogger?.log('similar_essay_opened', { similarity: essay.similarity_score }, essay.essay_id);
                              onOpenEssay(essay.essay_id);
                            }}
                            disabled={disableEssayOpen}
                            title={disableEssayOpen ? 'AI is grading — please wait' : undefined}
                            className={`w-full rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                              disableEssayOpen
                                ? 'cursor-not-allowed bg-[var(--card-border)] opacity-50'
                                : 'cursor-pointer bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20'
                            }`}
                          >
                            Open Essay →
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Benchmarks for current criterion */}
        {criterionName ? (
          <div className="border-t border-[var(--card-border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                Benchmarks
              </span>
              {loadingBenchmarks && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--muted)' }} />
              )}
            </div>
            <p className="mb-3 truncate text-[11px] italic" style={{ color: 'var(--muted)' }}>
              {criterionName}
            </p>
            {benchmarkError && (
              <p role="alert" className="mb-3 text-[11px] text-red-500">{benchmarkError}</p>
            )}
            {sortedBenchmarks.length === 0 && !loadingBenchmarks && (
              <p className="mb-3 text-[11px]" style={{ color: 'var(--muted)' }}>
                No benchmarks set yet — score an essay and use the &quot;Set as benchmark&quot; button.
              </p>
            )}
            <div className="space-y-2 mb-2">
              {sortedBenchmarks.map((b) => (
                <div key={b.benchmark_type} className="flex items-center justify-between rounded-lg bg-indigo-500/10 px-3 py-2">
                  <div className="min-w-0">
                    <span className="text-xs font-semibold text-indigo-500">Score {b.benchmark_type}</span>
                    <p className="truncate text-[11px]" style={{ color: 'var(--foreground)' }}>
                      {b.filename ?? b.essay_id.slice(0, 10)}
                    </p>
                  </div>
                  <button
                    onClick={() => removeBenchmarkEntry(b.benchmark_type)}
                    className="ml-2 shrink-0 cursor-pointer rounded p-0.5 text-indigo-500 hover:bg-black/10"
                    aria-label={`Remove score ${b.benchmark_type} benchmark`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Compare button, once a benchmark is set */}
            {sortedBenchmarks.length > 0 && (
              <button
                onClick={() => setShowComparison(true)}
                className="mt-2 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-600"
              >
                <BarChart2 className="h-3.5 w-3.5" />
                Compare with Benchmarks
              </button>
            )}
          </div>
        ) : (
          <div className="border-t border-[var(--card-border)] p-4">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Benchmarks appear once grading starts.
            </p>
          </div>
        )}
      </div>

      {/* Benchmark comparison modal */}
      {showComparison && criterionName && (
        <BenchmarkComparisonModal
          sessionId={sessionId}
          currentEssayId={essayId}
          currentAssessment={currentAssessment}
          criterionName={criterionName}
          benchmarks={sortedBenchmarks.map((b) => ({ type: b.benchmark_type, essayId: b.essay_id }))}
          onClose={() => setShowComparison(false)}
          actionLogger={actionLogger}
        />
      )}
    </>
  );
}
