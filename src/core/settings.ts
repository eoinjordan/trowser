/**
 * Settings storage.
 *
 * `normaliseSettings` is pure and does the whole validation job, so bad or
 * stale stored values can never reach the agent loop. The chrome.storage calls
 * are thin wrappers around it.
 */

import type { BackendId, Settings } from '../types';

export const SETTINGS_KEY = 'trowser.settings.v1';

export const DEFAULT_WEBLLM_MODEL = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b-instruct';
export const DEFAULT_OPENAI_URL = 'http://127.0.0.1:1234/v1';

export const BACKEND_IDS: BackendId[] = ['chrome-ai', 'webllm', 'ollama', 'openai-compatible'];

export const DEFAULT_SETTINGS: Settings = {
  backend: 'auto',
  webllmModel: DEFAULT_WEBLLM_MODEL,
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  openaiBaseUrl: DEFAULT_OPENAI_URL,
  openaiModel: '',
  openaiApiKey: '',
  maxSteps: 16,
  approveEverything: false,
  allowCrossOrigin: false,
  trustedOrigins: [],
  textBudget: 6000,
  elementBudget: 90,
  hfToken: '',
  githubClientId: '',
  googleClientId: ''
};

/** Coerces arbitrary stored data into a valid Settings object. */
export function normaliseSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const backend = input.backend;
  const validBackend = backend === 'auto' || BACKEND_IDS.includes(backend as BackendId);

  return {
    backend: validBackend ? (backend as Settings['backend']) : DEFAULT_SETTINGS.backend,
    webllmModel: str(input.webllmModel, DEFAULT_SETTINGS.webllmModel),
    ollamaBaseUrl: url(input.ollamaBaseUrl, DEFAULT_SETTINGS.ollamaBaseUrl),
    ollamaModel: str(input.ollamaModel, DEFAULT_SETTINGS.ollamaModel),
    openaiBaseUrl: url(input.openaiBaseUrl, DEFAULT_SETTINGS.openaiBaseUrl),
    openaiModel: str(input.openaiModel, DEFAULT_SETTINGS.openaiModel, true),
    openaiApiKey: str(input.openaiApiKey, DEFAULT_SETTINGS.openaiApiKey, true),
    maxSteps: int(input.maxSteps, 1, 60, DEFAULT_SETTINGS.maxSteps),
    approveEverything: bool(input.approveEverything, DEFAULT_SETTINGS.approveEverything),
    allowCrossOrigin: bool(input.allowCrossOrigin, DEFAULT_SETTINGS.allowCrossOrigin),
    trustedOrigins: origins(input.trustedOrigins),
    textBudget: int(input.textBudget, 500, 40000, DEFAULT_SETTINGS.textBudget),
    elementBudget: int(input.elementBudget, 10, 300, DEFAULT_SETTINGS.elementBudget),
    hfToken: str(input.hfToken, DEFAULT_SETTINGS.hfToken, true),
    githubClientId: str(input.githubClientId, DEFAULT_SETTINGS.githubClientId, true),
    googleClientId: str(input.googleClientId, DEFAULT_SETTINGS.googleClientId, true)
  };
}

/** Keeps only origins that parse and use an http(s) scheme. */
export function origins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const cleaned = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => {
      try {
        const parsed = new URL(entry.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  return Array.from(new Set(cleaned)).slice(0, 100);
}

function str(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) return fallback;
  return trimmed.slice(0, 2000);
}

function url(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normaliseSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normaliseSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    listener(normaliseSettings(changes[SETTINGS_KEY].newValue));
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** Redacts secrets before settings are written to a log or trace. */
export function redactSettings(settings: Settings): Record<string, unknown> {
  return {
    ...settings,
    openaiApiKey: settings.openaiApiKey ? '[set]' : '',
    hfToken: settings.hfToken ? '[set]' : ''
  };
}
