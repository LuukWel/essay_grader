import { NextRequest, NextResponse } from 'next/server';
import { startCohortProcessing } from '@/server/services/cohort-processing';

// POST: start the cohort pipeline in the background (see src/server/services/cohort-processing.ts).
// Progress: GET /api/sessions/[id] (processing_status, progress, runs).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = startCohortProcessing(id);
  switch (result.status) {
    case 'not_found':
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    case 'complete':
      return NextResponse.json({ status: 'complete' });
    default:
      return NextResponse.json({ status: 'processing' }, { status: 202 });
  }
}
