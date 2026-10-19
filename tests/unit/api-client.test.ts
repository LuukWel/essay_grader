// fetch() resolves on HTTP errors; sendJson has to turn them into thrown errors.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, saveFailedMessage, sendJson } from '@/lib/api-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('sendJson', () => {
  it('returns the parsed body on success and sends JSON', async () => {
    const fetchMock = stubFetch(async () => Response.json({ id: 12 }));
    await expect(sendJson('/api/x', 'POST', { a: 1 })).resolves.toEqual({ id: 12 });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('throws on HTTP 500 with the server error message', async () => {
    stubFetch(async () => Response.json({ error: 'Failed to upsert grade' }, { status: 500 }));
    const err = await sendJson('/api/x', 'POST', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, message: 'Failed to upsert grade' });
  });

  it('throws on an error response without a JSON body', async () => {
    stubFetch(async () => new Response('Bad Gateway', { status: 502 }));
    await expect(sendJson('/api/x', 'PATCH', {})).rejects.toMatchObject({
      status: 502,
      message: 'Request failed (HTTP 502)',
    });
  });

  it('throws with status 0 when the server cannot be reached', async () => {
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(sendJson('/api/x', 'DELETE')).rejects.toMatchObject({ status: 0 });
  });
});

describe('saveFailedMessage', () => {
  it('names what was not saved and why', () => {
    expect(saveFailedMessage('Grade for "Content"', new ApiError('Failed to upsert grade', 500)))
      .toBe('Grade for "Content" was not saved: Failed to upsert grade. Please try again.');
  });
});
