'use client';

import { useState, useEffect } from 'react';
import { CsvRecorder } from '@/lib/csv-recorder';
import { ActionLogger } from '@/lib/action-logger';
import type { StudySession } from '@/types';

const SESSION_KEY = 'essay_grader_study_session';
const INSTANCE_KEY = 'essay_grader_server_instance_id';

/** Session plus its recorder and logger, kept in one state value. */
interface ActiveSession {
  session: StudySession;
  recorder: CsvRecorder;
  logger: ActionLogger;
}

function activate(s: StudySession): ActiveSession {
  return {
    session: s,
    recorder: new CsvRecorder(s.participantId),
    logger: new ActionLogger(s.sessionId),
  };
}

function forgetStoredSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(INSTANCE_KEY);
}

/**
 * The session saved in localStorage, if the server that created it is still running and the
 * session exists and is not completed. Otherwise the saved session is removed.
 */
async function restoreSession(): Promise<StudySession | null> {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  let parsed: StudySession | null = null;
  try {
    parsed = JSON.parse(raw) as StudySession;
  } catch { /* handled below */ }
  if (!parsed?.sessionId) {
    forgetStoredSession();
    return null;
  }

  try {
    // Compare the server's process instance ID to the one captured when this session was
    // created. If the server has been restarted since, drop the session so the user lands
    // on the setup screen.
    const instance = await fetch('/api/instance').then((r) => (r.ok ? r.json() : null));
    if (!instance?.instanceId || instance.instanceId !== localStorage.getItem(INSTANCE_KEY)) {
      forgetStoredSession();
      return null;
    }
    // Same server instance: check the session still exists and isn't completed.
    const data = await fetch(`/api/sessions/${parsed.sessionId}`).then((r) => (r.ok ? r.json() : null));
    if (!data?.session || data.session.completed_at) {
      forgetStoredSession();
      return null;
    }
    return parsed;
  } catch {
    forgetStoredSession();
    return null;
  }
}

export function useSession() {
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore the session saved in this browser, if it is still valid.
  useEffect(() => {
    let cancelled = false;
    restoreSession().then((restored) => {
      if (cancelled) return;
      if (restored) setActive(activate(restored));
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const setSession = (s: StudySession) => {
    setActive(activate(s));
    if (typeof window !== 'undefined') {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      // Capture the current server instance ID so a restart invalidates this session.
      fetch('/api/instance')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.instanceId) localStorage.setItem(INSTANCE_KEY, data.instanceId);
        })
        .catch(() => { /* best-effort */ });
    }
  };

  const clearSession = () => {
    setActive(null);
    if (typeof window !== 'undefined') forgetStoredSession();
  };

  return {
    session: active?.session ?? null,
    setSession,
    clearSession,
    recorder: active?.recorder ?? null,
    actionLogger: active?.logger ?? null,
    isLoading,
  };
}
