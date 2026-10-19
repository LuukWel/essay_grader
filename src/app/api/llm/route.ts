import { NextRequest, NextResponse } from 'next/server';
import { gradeCriterion, reviseCriterionScore } from '@/server/services/llm-grading';
import { readJson } from '@/server/http';

// Interactive model calls from the grading screen (src/lib/llm-service.ts).
export async function POST(request: NextRequest) {
  try {
    const body = (await readJson(request)) as { action?: unknown; payload?: unknown } | undefined;

    switch (body?.action) {
      case 'gradeSingleCriterion':
        return NextResponse.json({ result: await gradeCriterion(body.payload as Parameters<typeof gradeCriterion>[0]) });
      case 'reviseCriterionScore':
        return NextResponse.json({ result: await reviseCriterionScore(body.payload as Parameters<typeof reviseCriterionScore>[0]) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    // Errors from the Ollama client already include the URL.
    console.error('LLM API route error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
