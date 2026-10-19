import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/server/db/sessions';
import { getPrecomputeStatus, startGradingPrecompute } from '@/server/services/grading-precompute';

// POST: start AI grade precompute in the background (see src/server/services/grading-precompute.ts).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = startGradingPrecompute(id);
  switch (result.status) {
    case 'not_found':
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    case 'started':
      return NextResponse.json({ status: 'started' }, { status: 202 });
    case 'running':
      return NextResponse.json({ status: 'running' }, { status: 202 });
    default:
      return NextResponse.json({ status: result.status });
  }
}

// GET: whether precompute is done or running, and the latest run with its counts.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json(getPrecomputeStatus(session));
}
