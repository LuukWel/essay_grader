import { NextRequest, NextResponse } from 'next/server';
import { getQualityRankLogs } from '@/server/db/action-logs';
import { getEssaysBySession } from '@/server/db/essays';
import { getSession } from '@/server/db/sessions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sessionId } = await params;

    const parsed = getQualityRankLogs(sessionId).map(row => {
      let ranks: { essayId: string; avgAiScore: number | null; rank: number }[] = [];
      try { ranks = JSON.parse(row.action_detail); } catch { /* skip malformed */ }
      return { timestamp: row.timestamp, ranks };
    });

    // Only keep snapshots where every essay has an avgAiScore (skips the ones
    // logged while precompute is still running), then drop consecutive
    // duplicates so the table only shows actual changes.
    const completeSnapshots = parsed.filter(s => s.ranks.length > 0 && s.ranks.every(r => r.avgAiScore !== null));

    const snapshots: typeof completeSnapshots = [];
    for (const snap of completeSnapshots) {
      const prev = snapshots[snapshots.length - 1];
      const sameAsPrev = prev && prev.ranks.length === snap.ranks.length
        && prev.ranks.every((r, i) => r.essayId === snap.ranks[i].essayId && r.rank === snap.ranks[i].rank);
      if (!sameAsPrev) snapshots.push(snap);
    }

    const essayNames: Record<string, string> = {};
    for (const e of getEssaysBySession(sessionId)) essayNames[e.id] = e.filename;

    const sessionStart = getSession(sessionId)?.created_at ?? null;

    return NextResponse.json({ snapshots, essayNames, sessionStart });
  } catch (err) {
    console.error('[api/rank-history GET]', err);
    return NextResponse.json({ error: 'Failed to fetch rank history' }, { status: 500 });
  }
}
