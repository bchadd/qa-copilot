/**
 * Thin client for the Ollama REST API.
 * Uses streaming so diagnosis appears token-by-token in the terminal.
 */

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  /** Base64-encoded images to include (multimodal models only, e.g. llava, qwen2.5vl) */
  images?: string[];
  /**
   * Request timeout in milliseconds. Defaults to 120 000 (2 min).
   * The client will retry once on timeout before giving up.
   */
  timeoutMs?: number;
}

export interface StreamChunk {
  response: string;
  done: boolean;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:14b';

export async function ollamaAvailable(baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels(baseUrl = DEFAULT_BASE_URL): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) return [];
  const data = (await res.json()) as { models: Array<{ name: string }> };
  return data.models.map((m) => m.name);
}

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Stream a prompt to Ollama. Calls `onToken` for each streamed token,
 * then resolves with the full response text.
 *
 * `onFirstToken` fires exactly once, immediately before the first token is
 * written — use it to stop a spinner so it clears before output begins.
 *
 * Retries once on timeout before throwing.
 */
export async function streamPrompt(
  prompt: string,
  onToken: (token: string) => void,
  opts: OllamaOptions = {},
  onFirstToken?: () => void,
): Promise<string> {
  const attempt = async (): Promise<string> => {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const model = opts.model ?? DEFAULT_MODEL;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const body: Record<string, unknown> = {
      model,
      prompt,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.2, // low temperature = deterministic code fixes
        num_ctx: 8192,
      },
    };

    // Attach images for multimodal models (llava, qwen2.5vl, etc.)
    if (opts.images && opts.images.length > 0) {
      body['images'] = opts.images;
    }

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Ollama request failed (${res.status}): ${errBody}`);
    }

    if (!res.body) throw new Error('No response body from Ollama');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let firstTokenFired = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line) as StreamChunk;
          if (chunk.response) {
            if (!firstTokenFired) {
              firstTokenFired = true;
              onFirstToken?.();
            }
            onToken(chunk.response);
            full += chunk.response;
          }
          if (chunk.done) break;
        } catch {
          // partial JSON line — skip
        }
      }
    }

    return full.trim();
  };

  try {
    return await attempt();
  } catch (err) {
    // Single retry on timeout — Ollama can be slow to warm up under load
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('timed out'));

    if (isTimeout) {
      return await attempt();
    }
    throw err;
  }
}

/**
 * Non-streaming variant — returns the full response at once.
 * Used for commit message generation where we don't need live output.
 */
export async function prompt(text: string, opts: OllamaOptions = {}): Promise<string> {
  let result = '';
  await streamPrompt(text, (token) => { result += token; }, opts);
  return result.trim();
}

/**
 * Read an image file from disk and return it as a base64 string
 * suitable for the Ollama multimodal API's `images` field.
 */
export function imageToBase64(filePath: string): string {
  // Dynamic require keeps this out of the module-level scope so the reporter
  // (which is loaded by Playwright in a separate process) doesn't pay the cost
  // unless it actually has screenshots to process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return fs.readFileSync(filePath).toString('base64');
}
