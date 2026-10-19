// Tests for the Ollama NDJSON stream parser. A frame can be split across chunks, and one
// chunk can hold several frames.

import { describe, expect, it } from 'vitest';
import { collectChatContent, readNdjson } from '@/server/integrations/ollama';

/** A byte stream that delivers `bytes` in the given chunks (split at byte offsets). */
function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function splitAt(text: string, ...offsets: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const bounds = [0, ...offsets, bytes.length];
  return bounds.slice(1).map((end, i) => bytes.slice(bounds[i], end));
}

function chunksOfSize(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of readNdjson(stream)) frames.push(frame);
  return frames;
}

const chat = (content: string) => JSON.stringify({ message: { role: 'assistant', content }, done: false });
const DONE = JSON.stringify({ done: true });

describe('readNdjson', () => {
  it('parses complete frames, one per chunk', async () => {
    const stream = streamOf([...splitAt('{"a":1}\n'), ...splitAt('{"a":2}\n')]);
    expect(await collect(stream)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('joins a frame split across two chunks', async () => {
    // chunk 1: {"response":"hel   chunk 2: lo"}\n
    const stream = streamOf(splitAt('{"response":"hello"}\n', 16));
    expect(await collect(stream)).toEqual([{ response: 'hello' }]);
  });

  it('parses several frames delivered in one chunk', async () => {
    const stream = streamOf(splitAt('{"a":1}\n{"a":2}\n{"a":3}\n'));
    expect(await collect(stream)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('flushes a final frame without a trailing newline', async () => {
    const stream = streamOf(splitAt('{"a":1}\n{"a":2}', 10));
    expect(await collect(stream)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const text = '{"t":"café 😀"}\n';
    const bytes = new TextEncoder().encode(text);
    const e = bytes.indexOf(0xc3); // first byte of "é"
    const emoji = bytes.indexOf(0xf0); // first byte of the 4-byte emoji
    const stream = streamOf(splitAt(text, e + 1, emoji + 2));
    expect(await collect(stream)).toEqual([{ t: 'café 😀' }]);
  });

  it('skips blank lines and handles CRLF line endings', async () => {
    const stream = streamOf(splitAt('{"a":1}\r\n\n\n{"a":2}\r\n'));
    expect(await collect(stream)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws on a complete line that is not JSON', async () => {
    const stream = streamOf(splitAt('{"a":1}\nnot json\n'));
    await expect(collect(stream)).rejects.toThrow(/Malformed line/);
  });

  it('throws when the stream is cut off mid-frame', async () => {
    const stream = streamOf(splitAt('{"a":1}\n{"a":'));
    await expect(collect(stream)).rejects.toThrow(/Malformed line/);
  });
});

describe('collectChatContent', () => {
  const reply = [chat('Hel'), chat('lo, '), chat('wörld'), chat(' 😀'), DONE].join('\n') + '\n';

  it('returns the same text for every chunk size', async () => {
    // Splits the stream at every possible byte boundary, including inside JSON strings
    // and inside multi-byte characters.
    for (let size = 1; size <= 40; size++) {
      expect(await collectChatContent(streamOf(chunksOfSize(reply, size)))).toBe('Hello, wörld 😀');
    }
  });

  it('throws on an error frame', async () => {
    const stream = streamOf(splitAt(chat('partial') + '\n' + JSON.stringify({ error: 'model not found' }) + '\n'));
    await expect(collectChatContent(stream)).rejects.toThrow('Ollama error: model not found');
  });

  it('throws when the stream ends before the done frame', async () => {
    const stream = streamOf(splitAt(chat('truncated reply') + '\n'));
    await expect(collectChatContent(stream)).rejects.toThrow(/before the done frame/);
  });

  it('stops at the done frame and cancels the rest of the stream', async () => {
    let cancelled = false;
    const chunks = [...splitAt(chat('ok') + '\n' + DONE + '\n'), ...splitAt(chat('ignored') + '\n')];
    const stream = streamOf(chunks, () => { cancelled = true; });
    expect(await collectChatContent(stream)).toBe('ok');
    expect(cancelled).toBe(true);
  });
});
