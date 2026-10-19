// Ollama client: configuration, chat and embedding calls, and the streaming parser.

export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
export const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

export interface ChatOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
  /** Aborts the HTTP request, e.g. AbortSignal.timeout(ms). */
  signal?: AbortSignal;
}

/** POSTs JSON to Ollama. Network errors are rethrown with the Ollama URL; timeouts and aborts pass through. */
async function postToOllama(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${OLLAMA_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err;
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`Cannot reach Ollama at ${OLLAMA_BASE_URL} (${reason}). Is it running?`);
  }
}

/** One chat turn (system + user prompt) against OLLAMA_MODEL. Returns the full reply text. */
export async function ollamaChat(system: string, prompt: string, options: ChatOptions = {}): Promise<string> {
  const res = await postToOllama('/api/chat', {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    stream: true,
    options: {
      temperature: options.temperature ?? 0.2,
      num_predict: options.num_predict ?? 2048,
      ...(options.num_ctx ? { num_ctx: options.num_ctx } : {}),
    },
  }, options.signal);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama request failed (${res.status}): ${text}`);
  }
  if (!res.body) {
    throw new Error('Ollama returned an empty response body');
  }

  return (await collectChatContent(res.body)).trim();
}

/** How text is prepared for embedding. Part of the cache key, so change it when the preparation changes. */
export const EMBED_INPUT_VERSION = 'first-8000-chars';
const EMBED_MAX_CHARS = 8000;

/** Embedding vector for one text (first 8000 characters) from OLLAMA_EMBED_MODEL. */
export async function ollamaEmbed(text: string, options: { signal?: AbortSignal } = {}): Promise<number[]> {
  const res = await postToOllama('/api/embed', {
    model: OLLAMA_EMBED_MODEL,
    input: text.slice(0, EMBED_MAX_CHARS),
  }, options.signal);

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${t}`);
  }

  const data = (await res.json()) as { embeddings?: unknown[] };
  const vec = data.embeddings?.[0];
  // An empty or non-numeric vector would make every similarity 0.
  if (!Array.isArray(vec) || vec.length === 0 || !vec.every((x) => Number.isFinite(x))) {
    throw new Error(`Ollama embed returned no valid embedding (model ${OLLAMA_EMBED_MODEL})`);
  }
  return vec as number[];
}

// Streaming

interface ChatFrame {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/** Joins the content of a streamed /api/chat response. Throws on an error frame or a missing done frame. */
export async function collectChatContent(stream: ReadableStream<Uint8Array>): Promise<string> {
  let content = '';
  for await (const frame of readNdjson(stream)) {
    const f = frame as ChatFrame;
    if (f.error) throw new Error(`Ollama error: ${f.error}`);
    if (f.message?.content) content += f.message.content;
    if (f.done) return content;
  }
  throw new Error('Ollama stream ended before the done frame');
}

/**
 * Yields each JSON value of an NDJSON stream. A frame can be split across chunks and a chunk
 * can hold several frames, so the unfinished last line is kept in `carry`. TextDecoder in
 * stream mode handles UTF-8 characters split across chunks.
 */
export async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      carry += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const lines = carry.split('\n');
      // Keep the incomplete last line for the next chunk; at the end, flush everything.
      carry = done ? '' : lines.pop()!;

      for (const line of lines) {
        if (line.trim()) yield parseFrame(line);
      }
      if (done) return;
    }
  } finally {
    // Release the connection, also when the consumer stops early or throws.
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`Malformed line in Ollama stream: ${line.slice(0, 200)}`);
  }
}
