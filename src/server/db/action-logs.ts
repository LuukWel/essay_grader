// Research event log (append-only).

import { getDb } from './client';

export interface ActionLogRow {
  id: number;
  session_id: string;
  participant_id: string;
  condition: string;
  essay_set: string;
  essay_id: string | null;
  action_type: string;
  action_detail: string | null;
  timestamp: string;
}

export function logAction(
  sessionId: string,
  participantId: string,
  condition: string,
  essaySet: string,
  actionType: string,
  essayId?: string,
  detail?: unknown,
): void {
  getDb().prepare(`
    INSERT INTO action_logs (session_id, participant_id, condition, essay_set, essay_id, action_type, action_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, participantId, condition, essaySet,
    essayId ?? null,
    actionType,
    detail ? JSON.stringify(detail) : null,
  );
}

/**
 * Decodes action_detail. Some rows from the study were JSON-encoded twice, so a string
 * result is parsed again. Text that isn't JSON is returned as is.
 */
export function parseActionDetail(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  } catch {
    return raw;
  }
}

/** All events of one session, or of every session of one participant, in time order. */
export function getActionLogs(filter: { sessionId: string } | { participantId: string }): ActionLogRow[] {
  const db = getDb();
  return ('sessionId' in filter
    ? db.prepare('SELECT * FROM action_logs WHERE session_id = ? ORDER BY timestamp').all(filter.sessionId)
    : db.prepare('SELECT * FROM action_logs WHERE participant_id = ? ORDER BY timestamp').all(filter.participantId)
  ) as ActionLogRow[];
}

/** The quality-rank snapshots of a session (action_detail holds the ranks as JSON). */
export function getQualityRankLogs(sessionId: string): { action_detail: string; timestamp: string }[] {
  return getDb().prepare(`
    SELECT action_detail, timestamp
    FROM action_logs
    WHERE session_id = ? AND action_type = 'quality_rank_updated'
    ORDER BY timestamp ASC
  `).all(sessionId) as { action_detail: string; timestamp: string }[];
}
