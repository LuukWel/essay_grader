import { NextRequest, NextResponse } from 'next/server';
import { getBenchmarks, setBenchmark, removeBenchmark } from '@/server/db/benchmarks';
import { getEssay } from '@/server/db/essays';
import { getSessionCriteria } from '@/server/db/rubrics';
import { readJson } from '@/server/http';
import { validateBenchmarkInput, validateBenchmarkRemoval } from '@/server/validation/benchmark';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const name = request.nextUrl.searchParams.get('criterion');
    if (!name) {
      return NextResponse.json({ error: 'criterion query param required' }, { status: 400 });
    }
    const criterion = getSessionCriteria(id).find((c) => c.name === name);
    if (!criterion) {
      return NextResponse.json({ error: `Unknown criterion "${name}"` }, { status: 400 });
    }

    // Includes each essay's filename and summary.
    return NextResponse.json({ benchmarks: getBenchmarks(id, criterion.id) });
  } catch (err) {
    console.error('[api/benchmarks GET]', err);
    return NextResponse.json({ error: 'Failed to fetch benchmarks' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const input = validateBenchmarkInput(await readJson(request), {
      sessionId: id, getEssay, criteria: getSessionCriteria(id),
    });
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }
    const { criterionId, score, essayId } = input.value;

    setBenchmark(id, criterionId, score, essayId, {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/benchmarks POST]', err);
    return NextResponse.json({ error: 'Failed to set benchmark' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const input = validateBenchmarkRemoval(await readJson(request), getSessionCriteria(id));
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: input.status });
    }

    removeBenchmark(id, input.value.criterionId, input.value.score);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/benchmarks DELETE]', err);
    return NextResponse.json({ error: 'Failed to remove benchmark' }, { status: 500 });
  }
}
