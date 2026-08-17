/**
 * WebLLM backend.
 *
 * Runs the model fully inside the browser on WebGPU, with weights fetched from
 * Hugging Face and cached by the browser. This is the "Ollama in the browser"
 * path: no daemon, no install, no key, and nothing leaves the device after the
 * one-time weight download.
 */

import type { DecideInput, LlmProvider, ModelInfo } from '../types';
import { extractJsonObject } from '../core/jsonrepair';
import { buildUserPrompt, SYSTEM_PROMPT } from '../core/prompt';
import { ACTION_SCHEMA } from '../core/schema';

type WebLlmModule = typeof import('@mlc-ai/web-llm');
type WebLlmEngine = import('@mlc-ai/web-llm').MLCEngineInterface;

export const WEBGPU_FIX =
  'WebLLM needs WebGPU. Use Chrome 121+ on a machine with a supported GPU.\n' +
  'Check chrome://gpu, and prefer the Chrome built-in or Ollama backend if WebGPU is unavailable.';

/**
 * Curated defaults, smallest first. The full prebuilt list is still offered in
 * options; these are the ones that behave acceptably as agents.
 */
export const RECOMMENDED_WEBLLM_MODELS: ModelInfo[] = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B Instruct', sizeMb: 1070 },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B Instruct', sizeMb: 2260 },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 3B Instruct', sizeMb: 2260 },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini Instruct', sizeMb: 2520 },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 7B Instruct', sizeMb: 5100 },
  { id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', label: 'Llama 3.1 8B Instruct', sizeMb: 5300 }
];

export class WebLlmProvider implements LlmProvider {
  readonly id = 'webllm' as const;
  readonly name = 'WebLLM';
  readonly locality = 'In this browser tab on WebGPU';

  private engine: WebLlmEngine | null = null;

  constructor(
    private readonly model: string,
    private readonly textBudget: number
  ) {}

  async initialize(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    if (!hasWebGpu()) throw new WebGpuUnavailableError('WebGPU is not available in this browser.');

    const webllm = (await import('@mlc-ai/web-llm')) as WebLlmModule;

    onProgress?.('Loading ' + this.model + '. First run downloads the weights and caches them.');

    this.engine = await webllm.CreateMLCEngine(this.model, {
      initProgressCallback: (report: { text: string; progress?: number }) => {
        if (signal?.aborted) return;
        const percent = typeof report.progress === 'number' ? ' (' + Math.round(report.progress * 100) + '%)' : '';
        onProgress?.(report.text + percent);
      }
    });

    onProgress?.(this.model + ' loaded and running on WebGPU.');
  }

  async decide(input: DecideInput): Promise<unknown> {
    if (!this.engine) throw new Error('WebLLM provider is not initialized.');

    const response = await this.engine.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input, this.textBudget) }
      ],
      temperature: 0.1,
      max_tokens: 512,
      // XGrammar-backed constrained decoding where the runtime supports it.
      response_format: { type: 'json_object', schema: JSON.stringify(ACTION_SCHEMA) }
    } as Parameters<WebLlmEngine['chat']['completions']['create']>[0]);

    const content = 'choices' in response ? response.choices?.[0]?.message?.content ?? '' : '';
    return extractJsonObject(content);
  }

  async dispose(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.unload();
    } finally {
      this.engine = null;
    }
  }
}

export class WebGpuUnavailableError extends Error {
  readonly fix = WEBGPU_FIX;

  constructor(message: string) {
    super(message);
    this.name = 'WebGpuUnavailableError';
  }
}

export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Merges the curated list with everything WebLLM ships prebuilt. */
export async function listWebLlmModels(): Promise<ModelInfo[]> {
  try {
    const webllm = (await import('@mlc-ai/web-llm')) as WebLlmModule;
    const prebuilt = webllm.prebuiltAppConfig.model_list.map((entry) => ({
      id: entry.model_id,
      label: entry.model_id,
      sizeMb: entry.vram_required_MB ? Math.round(entry.vram_required_MB) : undefined
    }));

    const seen = new Set(RECOMMENDED_WEBLLM_MODELS.map((entry) => entry.id));
    return [...RECOMMENDED_WEBLLM_MODELS, ...prebuilt.filter((entry) => !seen.has(entry.id))];
  } catch {
    return RECOMMENDED_WEBLLM_MODELS;
  }
}

export async function probeWebGpu(): Promise<{ ok: boolean; detail: string; fix?: string }> {
  if (!hasWebGpu()) return { ok: false, detail: 'navigator.gpu is not present.', fix: WEBGPU_FIX };

  try {
    const gpu = (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, detail: 'No WebGPU adapter available.', fix: WEBGPU_FIX };
    return { ok: true, detail: 'WebGPU adapter available.' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), fix: WEBGPU_FIX };
  }
}
