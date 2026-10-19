// Helper for writes that must not fail silently. fetch() only rejects on network errors,
// so HTTP 400/500 responses have to be checked explicitly.

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Sends a JSON request and returns the parsed response. Throws ApiError on a network error
 * (status 0) or a non-2xx response, with the server's `error` message if it sent one.
 */
export async function sendJson<T = unknown>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Could not reach the server', 0);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

/** "Grade was not saved: <reason>. Please try again." */
export function saveFailedMessage(what: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : 'unknown error';
  return `${what} was not saved: ${reason}. Please try again.`;
}
