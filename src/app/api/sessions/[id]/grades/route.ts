import { NextRequest, NextResponse } from 'next/server';
import { getGrades } from '@/server/db/grades';
import { getEssay } from '@/server/db/essays';
import { getSessionCriteria } from '@/server/db/rubrics';
import { readJson } from '@/server/http';
import { validateGradeUpdate } from '@/server/validation/grade';
import { saveGrade } from '@/server/services/grading-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const { searchParams } = new URL(_request.url);
    const essayId = searchParams.get('essayId');
    if (!essayId) {
      return NextResponse.json({ error: 'Missing essayId' }, { status: 400 });
    }
    const grades = getGrades(sessionId, essayId);
    return NextResponse.json({ grades });
  } catch (err) {
    console.error('[api/grades GET]', err);
    return NextResponse.json({ error: 'Failed to fetch grades' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;
    const input = validateGradeUpdate(await readJson(request), {
      sessionId, getEssay, criteria: getSessionCriteria(sessionId),
    });
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    // Fields left out of the request keep their stored value.
    const grade = saveGrade(sessionId, input.value);
    return NextResponse.json({ ok: true, grade });
  } catch (err) {
    console.error('[api/grades POST]', err);
    return NextResponse.json({ error: 'Failed to upsert grade' }, { status: 500 });
  }
}
