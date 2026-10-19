import { getDb } from './client';

export interface Topic {
  id: number;
  session_id: string;
  topic_index: number;
  /** JSON array of keywords */
  keywords: string;
  label: string | null;
}

/** model: assigned by the topic model; manual: moved by the teacher. */
export type AssignmentSource = 'model' | 'manual';

export interface TopicAssignment {
  id: number;
  session_id: string;
  essay_id: string;
  topic_id: number | null;
  source: AssignmentSource;
  assigned_at: string;
}

export function createTopic(sessionId: string, topicIndex: number, keywords: string[], label: string): number {
  const result = getDb().prepare(`
    INSERT INTO topics (session_id, topic_index, keywords, label) VALUES (?, ?, ?, ?)
  `).run(sessionId, topicIndex, JSON.stringify(keywords), label);
  return result.lastInsertRowid as number;
}

export function getTopicsBySession(sessionId: string): Topic[] {
  return getDb().prepare('SELECT * FROM topics WHERE session_id = ? ORDER BY topic_index').all(sessionId) as Topic[];
}

/**
 * Appends a topic assignment (null = no topic). The latest row is the current topic, so
 * earlier assignments, including the model's, are kept.
 */
export function assignTopic(sessionId: string, essayId: string, topicId: number | null, source: AssignmentSource): void {
  getDb().prepare(`
    INSERT INTO topic_assignments (session_id, essay_id, topic_id, source) VALUES (?, ?, ?, ?)
  `).run(sessionId, essayId, topicId, source);
}

/** Every assignment of a session, oldest first. */
export function getTopicAssignments(sessionId: string): TopicAssignment[] {
  return getDb().prepare('SELECT * FROM topic_assignments WHERE session_id = ? ORDER BY id')
    .all(sessionId) as TopicAssignment[];
}
