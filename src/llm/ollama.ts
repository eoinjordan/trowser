/**
 * Ollama backend.
 *
 * Talks to a local Ollama daemon over its native /api/chat endpoint so that
 * structured output can use Ollama's JSON-schema `format` parameter, which is
 * considerably more reliable than prompting alone on small models.
 *
 * Ollama refuses cross-origin requests it does not recognise, and a Chrome
 * extension origin is not allowed by default, so connection failures are
 * reported with the exact OLLAMA_ORIGINS remedy.
 */

import type { DecideInput, LlmProvider, ModelInfo } from '../types';
import { extractJsonObject } from '../core/jsonrepair';
import { buildUserPrompt, SYSTEM_PROMPT } from '../core/prompt';
import { ACTION_SCHEMA } from '../core/schema';
import { ProviderHttpError, formatBytes, readNdjson, request, requestJson } from './http';

export const OLLAMA_ORIGINS_FIX =
  'Start Ollama with the extension allowed as an origin, then reload Trowser:\n' +
  '  macOS/Linux:  OLLAMA_ORIGINS="chrome-extension://*" ollama serve\n' +
  '  Windows:      setx OLLAMA_ORIGINS "chrome-extension://*"  (then restart Ollama)';

const OFFLINE_FIX = 'Is Ollama running? Start it with "ollama serve".\n' + OLLAMA_ORIGINS_FIX;

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; size?: number }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly name = 'Ollama';
  readonly locality = 'Local daemon on this machine';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly textBudget: number
  ) {}

  async initialize(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    const models = await listOllamaModels(this.baseUrl, signal);

    if (!models.length) {
      throw new ProviderHttpError(
        'Ollama is running but has no models installed.',
        'Pull one first, for example: ollama pull ' + this.model
      );
    }

    const installed = models.some((entry) => entry.id === this.model || entry.id.split(':')[0] === this.model.split(':')[0]);
    if (!installed) {
      throw new ProviderHttpError(
        'Model "' + this.model + '" is not installed in Ollama.',
        'Run: ollama pull ' + this.model + '\nInstalled models: ' + models.map((entry) => entry.id).join(', ')
      );
    }

    onProgress?.('Ollama ready with ' + this.model + '.');
  }

  async decide(input: DecideInput): Promise<unknown> {
    const payload = await requestJson<OllamaChatResponse>(this.baseUrl + '/api/chat', {
      method: 'POST',
      label: 'Ollama',
      offlineFix: OFFLINE_FIX,
      signal: input.signal,
      body: {
        model: this.model,
        stream: false,
        format: ACTION_SCHEMA,
        options: { temperature: 0.1, num_predict: 512 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input, this.textBudget) }
        ]
      }
    });

    if (payload.error) {
      throw new ProviderHttpError('Ollama error: ' + payload.error, 'Check the model name and Ollama logs.');
    }

    return extractJsonObject(payload.message?.content ?? '');
  }

  async dispose(): Promise<void> {
    // Ollama keeps its own model lifecycle; nothing to release here.
  }
}

export async function listOllamaModels(baseUrl: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const payload = await requestJson<OllamaTagsResponse>(baseUrl + '/api/tags', {
    label: 'Ollama',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 8000,
    signal
  });

  return (payload.models ?? [])
    .map((entry) => {
      const id = entry.name ?? entry.model ?? '';
      return {
        id,
        label: id,
        sizeMb: entry.size ? Math.round(entry.size / 1_000_000) : undefined,
        installed: true
      };
    })
    .filter((entry) => entry.id.length > 0);
}

/**
 * Pulls a model into Ollama, reporting progress. Accepts both registry names
 * ("qwen2.5:7b-instruct") and Hugging Face GGUF references
 * ("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M").
 */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress?: (message: string, fraction?: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await request(baseUrl + '/api/pull', {
    method: 'POST',
    label: 'Ollama',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 0,
    signal,
    body: { model, stream: true }
  });

  let lastPercent = -1;

  await readNdjson(
    response,
    (line) => {
      if (typeof line.error === 'string') {
        throw new ProviderHttpError('Ollama pull failed: ' + line.error, 'Check the model name exists in the Ollama or Hugging Face registry.');
      }

      const status = typeof line.status === 'string' ? line.status : 'pulling';
      const completed = typeof line.completed === 'number' ? line.completed : 0;
      const total = typeof line.total === 'number' ? line.total : 0;

      if (total > 0) {
        const percent = Math.floor((completed / total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.(status + ' ' + percent + '% (' + formatBytes(completed) + ' / ' + formatBytes(total) + ')', completed / total);
        }
      } else {
        onProgress?.(status);
      }
    },
    signal
  );

  onProgress?.('Pulled ' + model + '.', 1);
}
