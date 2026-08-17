/**
 * OpenAI-compatible backend.
 *
 * One endpoint shape covers LM Studio, llama.cpp's server, vLLM, Jan, LocalAI,
 * text-generation-webui and the Hugging Face router. Support for structured
 * output varies wildly between them, so the provider negotiates downwards:
 * json_schema -> json_object -> plain prompting, remembering what worked.
 */

import type { DecideInput, LlmProvider, ModelInfo } from '../types';
import { extractJsonObject } from '../core/jsonrepair';
import { buildUserPrompt, SYSTEM_PROMPT } from '../core/prompt';
import { ACTION_SCHEMA } from '../core/schema';
import { ProviderHttpError, requestJson } from './http';

type StructuredMode = 'json_schema' | 'json_object' | 'none';

const MODE_LADDER: StructuredMode[] = ['json_schema', 'json_object', 'none'];

const OFFLINE_FIX =
  'Check the server is running and the base URL is correct.\n' +
  'LM Studio:   http://127.0.0.1:1234/v1  (enable the local server)\n' +
  'llama.cpp:   http://127.0.0.1:8080/v1  (llama-server)\n' +
  'vLLM:        http://127.0.0.1:8000/v1\n' +
  'Hugging Face: https://router.huggingface.co/v1';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string } | string;
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;
  readonly name = 'OpenAI-compatible endpoint';

  private mode: StructuredMode = 'json_schema';
  private resolvedModel: string;

  constructor(
    private readonly baseUrl: string,
    model: string,
    private readonly apiKey: string,
    private readonly textBudget: number
  ) {
    this.resolvedModel = model;
  }

  get locality(): string {
    return isLoopback(this.baseUrl) ? 'Local server on this machine' : 'Remote endpoint: ' + safeHost(this.baseUrl);
  }

  async initialize(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    let available: ModelInfo[] = [];

    try {
      available = await listOpenAiModels(this.baseUrl, this.apiKey, signal);
    } catch (error) {
      // Some servers do not implement /models. That is not fatal if the user
      // named a model explicitly.
      if (!this.resolvedModel) throw error;
    }

    if (!this.resolvedModel) {
      if (!available.length) {
        throw new ProviderHttpError('No model configured and the endpoint listed none.', 'Set a model name in Trowser options.');
      }
      this.resolvedModel = available[0].id;
      onProgress?.('No model configured; using ' + this.resolvedModel + '.');
    }

    onProgress?.('Connected to ' + safeHost(this.baseUrl) + ' with ' + this.resolvedModel + '.');
  }

  async decide(input: DecideInput): Promise<unknown> {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input, this.textBudget) }
    ];

    let lastError: unknown;

    for (const mode of MODE_LADDER.slice(MODE_LADDER.indexOf(this.mode))) {
      try {
        const payload = await requestJson<ChatResponse>(this.baseUrl + '/chat/completions', {
          method: 'POST',
          label: 'OpenAI-compatible endpoint',
          offlineFix: OFFLINE_FIX,
          signal: input.signal,
          headers: this.apiKey ? { authorization: 'Bearer ' + this.apiKey } : {},
          body: {
            model: this.resolvedModel,
            temperature: 0.1,
            max_tokens: 512,
            messages,
            ...responseFormatFor(mode)
          }
        });

        const error = typeof payload.error === 'string' ? payload.error : payload.error?.message;
        if (error) throw new ProviderHttpError('Endpoint error: ' + error, 'Check the model name and server logs.');

        // Remember the first mode that worked so later steps skip the probing.
        this.mode = mode;
        return extractJsonObject(payload.choices?.[0]?.message?.content ?? '');
      } catch (error) {
        lastError = error;
        // Only step down the ladder when the server rejected the request shape.
        const status = error instanceof ProviderHttpError ? error.status : undefined;
        if (status !== 400 && status !== 404 && status !== 422 && status !== 501) throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('The endpoint rejected every structured-output mode.');
  }

  async dispose(): Promise<void> {
    // Stateless HTTP; nothing to release.
  }
}

function responseFormatFor(mode: StructuredMode): Record<string, unknown> {
  if (mode === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'trowser_action', strict: false, schema: ACTION_SCHEMA }
      }
    };
  }
  if (mode === 'json_object') return { response_format: { type: 'json_object' } };
  return {};
}

export async function listOpenAiModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const payload = await requestJson<ModelsResponse>(baseUrl + '/models', {
    label: 'OpenAI-compatible endpoint',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 10_000,
    signal,
    headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {}
  });

  return (payload.data ?? [])
    .map((entry) => entry.id ?? '')
    .filter(Boolean)
    .map((id) => ({ id, label: id, installed: true }));
}

export function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
