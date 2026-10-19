import { NextRequest, NextResponse } from 'next/server';
import { logAction } from '@/server/db/action-logs';
import { getEssay } from '@/server/db/essays';
import { getSession } from '@/server/db/sessions';
import { readJson } from '@/server/http';

const MAX_ACTION_TYPE_LENGTH = 64;

// Appends a research event. Participant, condition and essay set come from the session, not the client.
export async function POST(request: NextRequest) {
  try {
    const body = (await readJson(request)) as Record<string, unknown> | undefined;
    const { sessionId, actionType, essayId, actionDetail } = body ?? {};

    if (typeof sessionId !== 'string' || typeof actionType !== 'string'
        || !actionType || actionType.length > MAX_ACTION_TYPE_LENGTH) {
      return NextResponse.json({ error: 'sessionId and actionType are required' }, { status: 400 });
    }
    if (essayId != null && typeof essayId !== 'string') {
      return NextResponse.json({ error: 'essayId must be a string' }, { status: 400 });
    }
    if (actionDetail != null && (typeof actionDetail !== 'object' || Array.isArray(actionDetail))) {
      return NextResponse.json({ error: 'actionDetail must be an object' }, { status: 400 });
    }

    const session = getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (essayId != null && getEssay(essayId)?.session_id !== sessionId) {
      return NextResponse.json({ error: 'Essay not found in this session' }, { status: 404 });
    }

    logAction(sessionId, session.participant_id, session.condition, session.essay_set,
      actionType, essayId ?? undefined, actionDetail ?? undefined);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/logs]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
