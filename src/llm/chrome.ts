/**
 * Chrome built-in AI backend (Gemini Nano via the Prompt API).
 *
 * This is the zero-install path: no download managed by us, no server, no key.
 * Chrome owns the model lifecycle, so the work here is availability probing,
 * download progress reporting, and constrained decoding via responseConstraint.
 */

import type { DecideInput, LlmProvider } from '../types';
import { extractJsonObject } from '../core/jsonrepair';
import { buildUserPrompt, SYSTEM_PROMPT } from '../core/prompt';
import { ACTION_SCHEMA } from '../core/schema';

export const CHROME_AI_FIX =
  'Chrome built-in AI needs Chrome 138+ on desktop with about 22 GB free disk space.\n' +
  'Open chrome://on-device-internals to check model status, or pick another backend in options.';

export class ChromeAiProvider implements LlmProvider {
  readonly id = 'chrome-ai' as const;
  readonly name = 'Chrome built-in AI';
  readonly locality = 'On-device, managed by Chrome';

  private session: LanguageModelSession | null = null;

  constructor(private readonly textBudget: number) {}

  async initialize(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<void> {
    if (typeof LanguageModel === 'undefined') {
      throw new ChromeAiUnavailableError('The Prompt API is not exposed in this browser.');
    }

    const availability = await LanguageModel.availability();

    if (availability === 'unavailable') {
      throw new ChromeAiUnavailableError('Chrome reports the built-in model is unavailable on this device.');
    }

    if (availability !== 'available') {
      onProgress?.('Chrome is downloading its built-in model. This happens once and can take a while.');
    }

    this.session = await LanguageModel.create({
      signal,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (event: Event) => {
          const loaded = (event as Event & { loaded?: number }).loaded;
          if (typeof loaded === 'number') {
            onProgress?.('Downloading Chrome built-in model: ' + Math.round(loaded * 100) + '%');
          }
        });
      }
    });

    onProgress?.('Chrome built-in model ready.');
  }

  async decide(input: DecideInput): Promise<unknown> {
    if (!this.session) throw new Error('Chrome provider is not initialized.');

    const raw = await this.session.prompt(buildUserPrompt(input, this.textBudget), {
      responseConstraint: ACTION_SCHEMA,
      signal: input.signal
    });

    return extractJsonObject(raw);
  }

  async dispose(): Promise<void> {
    this.session?.destroy();
    this.session = null;
  }
}

export class ChromeAiUnavailableError extends Error {
  readonly fix = CHROME_AI_FIX;

  constructor(message: string) {
    super(message);
    this.name = 'ChromeAiUnavailableError';
  }
}

/** Reports whether the Prompt API can be used, without creating a session. */
export async function probeChromeAi(): Promise<{ ok: boolean; detail: string; fix?: string }> {
  if (typeof LanguageModel === 'undefined') {
    return { ok: false, detail: 'Prompt API not available in this browser.', fix: CHROME_AI_FIX };
  }

  try {
    const availability = await LanguageModel.availability();
    if (availability === 'unavailable') {
      return { ok: false, detail: 'Model unavailable on this device.', fix: CHROME_AI_FIX };
    }
    if (availability === 'available') return { ok: true, detail: 'Ready.' };
    return { ok: true, detail: 'Available after a one-time download (' + availability + ').' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), fix: CHROME_AI_FIX };
  }
}
