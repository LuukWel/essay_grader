import { NextRequest, NextResponse } from 'next/server';
import { parseActionDetail, type ActionLogRow } from '@/server/db/action-logs';
import { loadExportRows } from '@/server/db/exports';
import { getSessionIdsForParticipant } from '@/server/db/sessions';

function computeTimingMetrics(logs: ActionLogRow[]) {
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  /* Total session time */
  const startLog = sorted.find((l) => l.action_type === 'session_start');
  const endLog = [...sorted].reverse().find((l) => l.action_type === 'session_end');
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const sessionStartMs = startLog
    ? new Date(startLog.timestamp).getTime()
    : first ? new Date(first.timestamp).getTime() : null;
  const sessionEndMs = endLog
    ? new Date(endLog.timestamp).getTime()
    : last ? new Date(last.timestamp).getTime() : null;
  const total_session_seconds =
    sessionStartMs != null && sessionEndMs != null
      ? Math.round((sessionEndMs - sessionStartMs) / 1000)
      : null;

  /* Per-essay time: essay_opened until all_grades_submitted or essay_closed */
  const essayWindows: Record<string, { opened_ms?: number; completed_ms?: number; filename?: string }> = {};
  for (const log of sorted) {
    if (!log.essay_id) continue;
    if (!essayWindows[log.essay_id]) essayWindows[log.essay_id] = {};
    if (log.action_type === 'essay_opened') {
      essayWindows[log.essay_id].opened_ms = new Date(log.timestamp).getTime();
    }
    if (log.action_type === 'all_grades_submitted' || log.action_type === 'essay_closed') {
      essayWindows[log.essay_id].completed_ms = new Date(log.timestamp).getTime();
    }
  }
  const per_essay = Object.entries(essayWindows).map(([essay_id, w]) => ({
    essay_id,
    time_seconds: w.opened_ms != null && w.completed_ms != null
      ? Math.round((w.completed_ms - w.opened_ms) / 1000)
      : null,
  }));

  /* Dashboard time: dashboard_viewed until the next non-dashboard action */
  const dashboardNavActions = new Set(['topic_selected', 'essay_sort_changed', 'essay_flagged', 'essay_unflagged', 'help_tooltip_opened']);
  let dashboard_time_seconds = 0;
  let lastDashboardMs: number | null = null;
  for (const log of sorted) {
    if (log.action_type === 'dashboard_viewed') {
      lastDashboardMs = new Date(log.timestamp).getTime();
    } else if (lastDashboardMs != null && !dashboardNavActions.has(log.action_type)) {
      dashboard_time_seconds += Math.round((new Date(log.timestamp).getTime() - lastDashboardMs) / 1000);
      lastDashboardMs = null;
    }
  }

  /* Comparison time: benchmark_comparison_opened until benchmark_comparison_closed */
  let comparison_time_seconds = 0;
  let lastComparisonMs: number | null = null;
  const comparison_events: { opened_at: string; closed_at: string; duration_seconds: number }[] = [];
  for (const log of sorted) {
    if (log.action_type === 'benchmark_comparison_opened') {
      lastComparisonMs = new Date(log.timestamp).getTime();
    } else if (log.action_type === 'benchmark_comparison_closed' && lastComparisonMs != null) {
      const dur = Math.round((new Date(log.timestamp).getTime() - lastComparisonMs) / 1000);
      comparison_time_seconds += dur;
      comparison_events.push({
        opened_at: new Date(lastComparisonMs).toISOString(),
        closed_at: log.timestamp,
        duration_seconds: dur,
      });
      lastComparisonMs = null;
    }
  }

  return {
    total_session_seconds,
    dashboard_time_seconds: dashboard_time_seconds || null,
    comparison_time_seconds: comparison_time_seconds || null,
    comparison_events,
    per_essay,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const participantId = searchParams.get('participantId');

    if (!sessionId && !participantId) {
      return NextResponse.json({ error: 'sessionId or participantId required' }, { status: 400 });
    }

    const sessionIds = sessionId ? [sessionId] : getSessionIdsForParticipant(participantId!);
    if (sessionIds.length === 0) {
      return NextResponse.json({ error: 'No sessions found' }, { status: 404 });
    }

    const {
      sessions, rubricCriteria, essays, topicAssignments, grades, benchmarks, similarities, actionLogs,
    } = loadExportRows(sessionIds);

    /* action_detail as a value (also decodes rows that were stored double-encoded) */
    const parsedLogs = actionLogs.map((l) => ({ ...l, action_detail: parseActionDetail(l.action_detail) }));

    /* Compute timing per session */
    const timing_metrics: Record<string, ReturnType<typeof computeTimingMetrics>> = {};
    for (const sid of sessionIds) {
      timing_metrics[sid] = computeTimingMetrics(actionLogs.filter((l) => l.session_id === sid));
    }

    const exportData = {
      export_date: new Date().toISOString(),
      sessions,
      rubric_criteria: rubricCriteria,
      essays,
      topic_assignments: topicAssignments,
      grades,
      benchmarks,
      essay_similarities: similarities,
      action_logs: parsedLogs,
      timing_metrics,
    };

    const filename = `export_${participantId ?? sessionId}_${new Date().toISOString().split('T')[0]}.json`;

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('[api/export/all GET]', err);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}
