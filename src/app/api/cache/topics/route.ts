import { NextRequest, NextResponse } from 'next/server';
import { clearTopicModelCache, getCachedTopicKs } from '@/server/db/caches';
import { DEFAULT_TOPIC_K, TOPIC_EMBED_MODEL, TOPIC_LLM_MODEL, topicModelInputs } from '@/server/services/topic-model';
import { isEssaySet, readEssaySetCsv } from '@/server/files/essay-sets';
import { parseEssayCsv } from '@/server/validation/essay-import';

// GET ?set=C: the k values with stored BGE + Gemma topics for this set's current essays
export async function GET(request: NextRequest) {
  const essaySet = new URL(request.url).searchParams.get('set');
  if (!isEssaySet(essaySet)) {
    return NextResponse.json({ error: 'unknown essay set' }, { status: 400 });
  }

  // Only count topics computed from the current essays.
  const parsed = parseEssayCsv(readEssaySetCsv(essaySet).csvText);
  let cachedK: number[] = [];
  if (parsed.ok) {
    const essays = parsed.rows.map((r) => ({ tsvId: r.sourceId, text: r.essay }));
    // Match essays, models and method; list the k values.
    cachedK = getCachedTopicKs(topicModelInputs(essaySet, DEFAULT_TOPIC_K, essays));
  }

  return NextResponse.json({
    set: essaySet,
    cachedK,
    embedModel: TOPIC_EMBED_MODEL,
    llmModel: TOPIC_LLM_MODEL,
  });
}

// DELETE ?set=C: clear the cached topics for that set (all k), or everything if no set is given
export async function DELETE(request: NextRequest) {
  const essaySet = new URL(request.url).searchParams.get('set');

  if (essaySet) {
    if (!isEssaySet(essaySet)) {
      return NextResponse.json({ error: 'unknown essay set' }, { status: 400 });
    }
    return NextResponse.json({ deleted: clearTopicModelCache(essaySet), set: essaySet });
  }

  return NextResponse.json({ deleted: clearTopicModelCache() });
}
