import { NextRequest, NextResponse } from 'next/server';
import { completeSession, getSession, getSessionProgress, getSessionStats } from '@/server/db/sessions';
import { listEssayMetas } from '@/server/db/essays';
import { getRubricCriteria } from '@/server/db/rubrics';
import { getTopicsBySession } from '@/server/db/topics';
import { getLatestRun } from '@/server/db/pipeline-runs';
import { INSTANCE_ID } from '@/server/instance';
import { readJson } from '@/server/http';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const runs = {
      cohort: getLatestRun(id, 'cohort_processing', INSTANCE_ID),
      precompute: getLatestRun(id, 'grading_precompute', INSTANCE_ID),
    };
    const precompute = runs.precompute
      ? { done: runs.precompute.processed_items + runs.precompute.failed_items, expected: runs.precompute.expected_items }
      : null;

    return NextResponse.json({
      session,
      criteria: getRubricCriteria(session.rubric_id),
      essays: listEssayMetas(id),
      topics: getTopicsBySession(id),
      stats: getSessionStats(id),
      progress: { ...getSessionProgress(id), precompute },
      runs,
    });
  } catch (error) {
    console.error('GET /api/sessions/[id] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch session' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!getSession(id)) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const body = await readJson(request);
    if (typeof body !== 'object' || body === null || (body as { complete?: unknown }).complete !== true) {
      return NextResponse.json({ error: 'Expected {"complete": true}' }, { status: 400 });
    }
    completeSession(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/sessions/[id] error:', err);
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }
}
