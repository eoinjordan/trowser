/**
 * Provider registry.
 *
 * `auto` walks a preference ladder so a fresh install works with whatever the
 * machine already has: Chrome's built-in model first (nothing to install), then
 * a running Ollama daemon (best quality for the size), then an OpenAI-compatible
 * server, then WebLLM (always possible on a WebGPU machine but the heaviest
 * first-run cost).
 */

import type { BackendId, LlmProvider, ProviderStatus, Settings } from '../types';
import { ChromeAiProvider, probeChromeAi } from './chrome';
import { OllamaProvider, listOllamaModels } from './ollama';
import { OpenAiCompatibleProvider, listOpenAiModels } from './openai';
import { WebLlmProvider, probeWebGpu } from './webllm';

export const AUTO_ORDER: BackendId[] = ['chrome-ai', 'ollama', 'openai-compatible', 'webllm'];

export const BACKEND_LABELS: Record<BackendId, string> = {
  'chrome-ai': 'Chrome built-in AI',
  webllm: 'WebLLM (WebGPU)',
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible endpoint'
};

export function createProvider(backend: BackendId, settings: Settings): LlmProvider {
  switch (backend) {
    case 'chrome-ai':
      return new ChromeAiProvider(settings.textBudget);
    case 'webllm':
      return new WebLlmProvider(settings.webllmModel, settings.textBudget);
    case 'ollama':
      return new OllamaProvider(settings.ollamaBaseUrl, settings.ollamaModel, settings.textBudget);
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(settings.openaiBaseUrl, settings.openaiModel, settings.openaiApiKey, settings.textBudget);
    default:
      throw new Error('Unknown backend: ' + backend);
  }
}

export interface ResolveResult {
  provider: LlmProvider;
  /** Backends that were tried and failed, for display in the trace. */
  skipped: Array<{ backend: BackendId; reason: string }>;
}

/**
 * Initializes the configured backend, or the first working one under `auto`.
 * Throws an aggregated, actionable error when nothing is usable.
 */
export async function resolveProvider(
  settings: Settings,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<ResolveResult> {
  const order: BackendId[] = settings.backend === 'auto' ? AUTO_ORDER : [settings.backend];
  const skipped: Array<{ backend: BackendId; reason: string }> = [];

  for (const backend of order) {
    const provider = createProvider(backend, settings);

    try {
      if (order.length > 1) onProgress?.('Trying ' + BACKEND_LABELS[backend] + '...');
      await provider.initialize(onProgress, signal);
      return { provider, skipped };
    } catch (error) {
      if (signal?.aborted) throw error;

      await provider.dispose().catch(() => undefined);
      const reason = describeError(error);
      skipped.push({ backend, reason });

      // An explicitly chosen backend must fail loudly rather than fall back.
      if (order.length === 1) throw error;
      onProgress?.(BACKEND_LABELS[backend] + ' unavailable: ' + reason);
    }
  }

  const summary = skipped.map((entry) => '  - ' + BACKEND_LABELS[entry.backend] + ': ' + entry.reason).join('\n');
  throw new Error('No local model backend is available.\n' + summary + '\n\nOpen Trowser options to configure one.');
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extracts the remediation string a provider error carries, if any. */
export function describeFix(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'fix' in error) {
    const fix = (error as { fix?: unknown }).fix;
    if (typeof fix === 'string') return fix;
  }
  return undefined;
}

/** Probes one backend for the options page status panel. */
export async function probeBackend(backend: BackendId, settings: Settings): Promise<ProviderStatus> {
  try {
    switch (backend) {
      case 'chrome-ai':
        return await probeChromeAi();
      case 'webllm':
        return await probeWebGpu();
      case 'ollama': {
        const models = await listOllamaModels(settings.ollamaBaseUrl);
        return models.length
          ? { ok: true, detail: models.length + ' model(s) installed: ' + models.slice(0, 4).map((entry) => entry.id).join(', ') }
          : { ok: false, detail: 'Ollama is reachable but has no models.', fix: 'Run: ollama pull ' + settings.ollamaModel };
      }
      case 'openai-compatible': {
        const models = await listOpenAiModels(settings.openaiBaseUrl, settings.openaiApiKey);
        return { ok: true, detail: models.length + ' model(s) available.' };
      }
      default:
        return { ok: false, detail: 'Unknown backend.' };
    }
  } catch (error) {
    return { ok: false, detail: describeError(error), fix: describeFix(error) };
  }
}

export { ChromeAiProvider, OllamaProvider, OpenAiCompatibleProvider, WebLlmProvider };
