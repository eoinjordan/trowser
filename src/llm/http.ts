/**
 * HTTP helpers shared by the network-backed providers.
 *
 * Local inference servers fail in a small number of very specific ways
 * (not running, CORS not opened to the extension origin, model not pulled).
 * Guessing badly here wastes a lot of user time, so errors carry an explicit
 * remediation string that the UI renders verbatim.
 */

export class ProviderHttpError extends Error {
  constructor(message: string, readonly fix: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Milliseconds before the request is aborted. Pass 0 to disable the timeout. */
  timeoutMs?: number;
  /** Label used in error messages, e.g. "Ollama". */
  label: string;
  /** Remediation shown when the server cannot be reached at all. */
  offlineFix: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function requestJson<T>(url: string, options: RequestOptions): Promise<T> {
  const response = await request(url, options);
  const text = await response.text();

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(
      options.label + ' returned a non-JSON response: ' + text.slice(0, 200),
      'Check that ' + url + ' is an API endpoint and not a web page.'
    );
  }
}

export async function request(url: string, options: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  // A model pull has no meaningful upper bound, so 0 disables the timeout.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : undefined;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ProviderHttpError(
      'Could not reach ' + options.label + ' at ' + url + '.',
      options.offlineFix,
      undefined
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProviderHttpError(
      options.label + ' returned ' + response.status + ' ' + response.statusText + (detail ? ': ' + detail : ''),
      explainStatus(response.status, options.label),
      response.status
    );
  }

  return response;
}

export function explainStatus(status: number, label: string): string {
  if (status === 401 || status === 403) return 'Check the API key configured for ' + label + ' in Trowser options.';
  if (status === 404) return 'The model or endpoint was not found. Check the model name and base URL in Trowser options.';
  if (status === 429) return label + ' is rate limiting. Wait a moment or use a local backend.';
  if (status >= 500) return label + ' hit a server error. Check its logs.';
  return 'Check the ' + label + ' configuration in Trowser options.';
}

/** Reads an NDJSON stream, invoking `onLine` for each decoded object. */
export async function readNdjson(response: Response, onLine: (value: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderHttpError('Streaming response had no body.', 'Retry the operation.');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onLine(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // A partial line can appear at a chunk boundary; skip it.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        onLine(JSON.parse(tail) as Record<string, unknown>);
      } catch {
        // Ignore a trailing partial line.
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Formats a byte count for progress messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return (value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[exponent];
}
