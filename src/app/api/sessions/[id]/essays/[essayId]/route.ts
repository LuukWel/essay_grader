import { NextRequest, NextResponse } from 'next/server';
import { getEssay, updateEssayGrade, updateEssayFlag } from '@/server/db/essays';
import { getGrades } from '@/server/db/grades';
import { getSessionCriteria } from '@/server/db/rubrics';
import { assignTopic, getTopicsBySession } from '@/server/db/topics';
import { readJson } from '@/server/http';
import { validateEssayUpdate } from '@/server/validation/essay';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; essayId: string }> },
) {
  try {
    const { id, essayId } = await params;
    const essay = getEssay(essayId);

    if (!essay || essay.session_id !== id) {
      return NextResponse.json({ error: 'Essay not found' }, { status: 404 });
    }

    const grades = getGrades(id, essayId);
    return NextResponse.json({ essay, grades });
  } catch (err) {
    console.error('[api/essays/[essayId] GET]', err);
    return NextResponse.json({ error: 'Failed to fetch essay' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; essayId: string }> },
) {
  try {
    const { id, essayId } = await params;
    const essay = getEssay(essayId);
    if (!essay || essay.session_id !== id) {
      return NextResponse.json({ error: 'Essay not found' }, { status: 404 });
    }

    const topicIds = getTopicsBySession(id).map((t) => t.id);
    const input = validateEssayUpdate(await readJson(request), { topicIds, criteria: getSessionCriteria(id) });
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    const { grading, isFlagged, topic } = input.value;

    if (grading) {
      updateEssayGrade(essayId, grading.status);
    }
    if (isFlagged !== undefined) {
      updateEssayFlag(essayId, isFlagged);
    }
    if (topic) {
      // Appended, so earlier assignments (including the model's) are kept.
      assignTopic(id, essayId, topic.topicId, 'manual');
    }

    return NextResponse.json({ ok: true, essay: getEssay(essayId) });
  } catch (err) {
    console.error('[api/essays/[essayId] PATCH]', err);
    return NextResponse.json({ error: 'Failed to update essay' }, { status: 500 });
  }
}
