import { NextRequest, NextResponse } from 'next/server';
import {
  createTeacherHighlight,
  deleteTeacherHighlight,
  getTeacherHighlights,
  getTeacherHighlightsBySession,
} from '@/server/db/highlights';
import { getEssay } from '@/server/db/essays';
import { getSessionCriteria } from '@/server/db/rubrics';
import { readJson } from '@/server/http';
import { validateHighlightInput } from '@/server/validation/highlight';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const essayId = request.nextUrl.searchParams.get('essayId');
    const highlights = essayId
      ? getTeacherHighlights(sessionId, essayId)
      : getTeacherHighlightsBySession(sessionId);
    return NextResponse.json({ highlights });
  } catch (err) {
    console.error('GET /api/sessions/[id]/highlights error:', err);
    return NextResponse.json({ error: 'Failed to fetch teacher highlights' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const input = validateHighlightInput(await readJson(request), {
      sessionId, getEssay, criteria: getSessionCriteria(sessionId),
    });
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    const { essayId, criterionId, startIndex, endIndex, text } = input.value;
    const highlightId = createTeacherHighlight(sessionId, essayId, criterionId, startIndex, endIndex, text);
    return NextResponse.json({ id: highlightId });
  } catch (err) {
    console.error('POST /api/sessions/[id]/highlights error:', err);
    return NextResponse.json({ error: 'Failed to create teacher highlight' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const highlightIdRaw = request.nextUrl.searchParams.get('id');
    const highlightId = highlightIdRaw ? parseInt(highlightIdRaw, 10) : NaN;
    if (!Number.isFinite(highlightId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const removed = deleteTeacherHighlight(sessionId, highlightId);
    if (!removed) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    console.error('DELETE /api/sessions/[id]/highlights error:', err);
    return NextResponse.json({ error: 'Failed to delete teacher highlight' }, { status: 500 });
  }
}
