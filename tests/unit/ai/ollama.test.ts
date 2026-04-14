import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ollamaAvailable, listModels, streamPrompt } from '../../../src/ai/ollama';

// ---------------------------------------------------------------------------
// Helpers — build mock streaming responses
// ---------------------------------------------------------------------------

/**
 * Builds a ReadableStream that emits Ollama-style NDJSON chunks.
 * Each string in `tokens` becomes one `{ response: token, done: false }` line,
 * followed by a final `{ response: "", done: true }` line.
 */
function makeStream(tokens: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = [
    ...tokens.map((t) => JSON.stringify({ response: t, done: false })),
    JSON.stringify({ response: '', done: true }),
  ];

  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
}

function mockFetchOk(tokens: string[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: makeStream(tokens),
    text: async () => '',
  });
}

function mockFetchError(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    body: null,
    text: async () => body,
  });
}

// ---------------------------------------------------------------------------
// ollamaAvailable
// ---------------------------------------------------------------------------

describe('ollamaAvailable', () => {
  beforeEach(() => { vi.stubGlobal('fetch', undefined); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns true when fetch responds ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(await ollamaAvailable('http://localhost:11434')).toBe(true);
  });

  it('returns false when fetch responds not-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await ollamaAvailable('http://localhost:11434')).toBe(false);
  });

  it('returns false when fetch throws (server unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await ollamaAvailable('http://localhost:11434')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

describe('listModels', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns model names from the tags response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5-coder:14b' },
          { name: 'llava:7b' },
        ],
      }),
    }));

    const models = await listModels();
    expect(models).toEqual(['qwen2.5-coder:14b', 'llava:7b']);
  });

  it('returns an empty array when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await listModels()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// streamPrompt
// ---------------------------------------------------------------------------

describe('streamPrompt', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('accumulates all tokens into the returned string', async () => {
    vi.stubGlobal('fetch', mockFetchOk(['Hello', ', ', 'world', '!']));

    const result = await streamPrompt('prompt', () => {});
    expect(result).toBe('Hello, world!');
  });

  it('calls onToken for each token in order', async () => {
    vi.stubGlobal('fetch', mockFetchOk(['foo', 'bar', 'baz']));

    const received: string[] = [];
    await streamPrompt('prompt', (t) => received.push(t));
    expect(received).toEqual(['foo', 'bar', 'baz']);
  });

  it('calls onFirstToken exactly once, before the first onToken call', async () => {
    vi.stubGlobal('fetch', mockFetchOk(['a', 'b', 'c']));

    const order: string[] = [];
    await streamPrompt(
      'prompt',
      (t) => order.push(`token:${t}`),
      {},
      () => order.push('first'),
    );

    expect(order[0]).toBe('first');
    expect(order.filter((e) => e === 'first')).toHaveLength(1);
  });

  it('does not call onFirstToken when the response has no tokens', async () => {
    // Stream with only the done sentinel
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(JSON.stringify({ response: '', done: true }) + '\n'));
          c.close();
        },
      }),
      text: async () => '',
    }));

    const firstTokenCb = vi.fn();
    await streamPrompt('prompt', () => {}, {}, firstTokenCb);
    expect(firstTokenCb).not.toHaveBeenCalled();
  });

  it('throws when the response status is not ok', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'internal error'));
    await expect(streamPrompt('prompt', () => {})).rejects.toThrow('500');
  });

  it('throws when the response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: null, text: async () => '' }));
    await expect(streamPrompt('prompt', () => {})).rejects.toThrow('No response body');
  });

  it('retries once on TimeoutError and succeeds on the second attempt', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(timeoutError);
      return Promise.resolve({ ok: true, body: makeStream(['ok']), text: async () => '' });
    }));

    const result = await streamPrompt('prompt', () => {});
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows after two timeout failures (no infinite retry)', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    await expect(streamPrompt('prompt', () => {})).rejects.toThrow('timed out');
  });

  it('does not retry on non-timeout errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(streamPrompt('prompt', () => {})).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes images in the request body when provided', async () => {
    const fetchMock = mockFetchOk(['hi']);
    vi.stubGlobal('fetch', fetchMock);

    await streamPrompt('prompt', () => {}, { images: ['base64abc'] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.images).toEqual(['base64abc']);
  });

  it('omits the images field when no images are provided', async () => {
    const fetchMock = mockFetchOk(['hi']);
    vi.stubGlobal('fetch', fetchMock);

    await streamPrompt('prompt', () => {});

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.images).toBeUndefined();
  });
});
