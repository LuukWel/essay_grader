import { NextRequest, NextResponse } from 'next/server';
import { findResumableSession } from '@/server/db/sessions';
import { listEssayMetas } from '@/server/db/essays';
import { logAction } from '@/server/db/action-logs';
import { RubricConflictError, getSessionCriteria } from '@/server/db/rubrics';
import { activeRubric, isEssaySet, readEssaySetCsv } from '@/server/files/essay-sets';
import { readJson } from '@/server/http';
import { validateSessionInput } from '@/server/validation/session';
import { ImportError, createSessionWithEssays } from '@/server/services/session-service';

export async function POST(request: NextRequest) {
  try {
    const input = validateSessionInput(await readJson(request), { isEssaySet });
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    const { participantId, condition, essaySet, precomputeGrades } = input.value;

    // Resume an unfinished session with the same participantId, condition and
    // essaySet instead of importing the essays again.
    const existing = findResumableSession(participantId, condition, essaySet);
    if (existing) {
      logAction(existing.id, participantId, condition, essaySet, 'session_start', undefined, { resumed: true });
      return NextResponse.json({
        sessionId: existing.id,
        rubricContent: existing.rubric_content,
        criteria: getSessionCriteria(existing.id),
        essays: listEssayMetas(existing.id),
        precomputeGrades: existing.precompute_grades === 1,
        resumed: true,
      });
    }

    const rubric = activeRubric();
    const sessionId = createSessionWithEssays(input.value, { ...readEssaySetCsv(essaySet), rubric });
    logAction(sessionId, participantId, condition, essaySet, 'session_start');

    // Essays are returned with full content for in-memory use.
    return NextResponse.json({
      sessionId,
      rubricContent: rubric.sourceText,
      criteria: rubric.criteria,
      essays: listEssayMetas(sessionId),
      precomputeGrades,
      resumed: false,
    });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message, details: error.errors }, { status: 400 });
    }
    if (error instanceof RubricConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('POST /api/sessions error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create session' },
      { status: 500 }
    );
  }
}
