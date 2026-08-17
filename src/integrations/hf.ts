/**
 * Hugging Face integration.
 *
 * Three distinct roles, all optional:
 *   1. Discovery  - search the Hub for MLC (WebLLM) and GGUF (Ollama) models.
 *   2. Access     - supply a token so gated repos and higher rate limits work.
 *   3. Inference  - use the HF router as an OpenAI-compatible endpoint.
 *
 * The URL builders and reference parsers are pure so they can be unit tested
 * without touching the network.
 */

import type { ModelInfo } from '../types';
import { ProviderHttpError, requestJson } from '../llm/http';

export const HF_API = 'https://huggingface.co/api';
export const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/v1';

const OFFLINE_FIX = 'Check your network connection, or set a Hugging Face token in Trowser options if the repo is gated.';

/** Quantisations offered for GGUF pulls, best quality/size tradeoff first. */
export const GGUF_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'Q6_K', 'Q3_K_M', 'IQ4_XS', 'F16'];

export type HfModelKind = 'mlc' | 'gguf';

export interface HfModel extends ModelInfo {
  repo: string;
  downloads?: number;
  likes?: number;
  gated?: boolean;
  kind: HfModelKind;
}

interface HfApiModel {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  siblings?: Array<{ rfilename?: string }>;
}

interface HfWhoAmI {
  name?: string;
  fullname?: string;
  email?: string;
  avatarUrl?: string;
  type?: string;
  auth?: { accessToken?: { role?: string } };
}

/** Builds a Hub search URL for the model kind Trowser can actually run. */
export function buildSearchUrl(query: string, kind: HfModelKind, limit = 25): string {
  const url = new URL(HF_API + '/models');
  const search = query.trim();

  if (kind === 'mlc') {
    // WebLLM consumes MLC-compiled weights; the -MLC suffix is the convention.
    url.searchParams.set('search', search ? search + ' MLC' : 'MLC');
    url.searchParams.set('library', 'mlc-llm');
  } else {
    url.searchParams.set('search', search ? search + ' GGUF' : 'GGUF');
    url.searchParams.set('filter', 'gguf');
  }

  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  return url.toString();
}

export function authHeaders(token: string): Record<string, string> {
  const trimmed = token.trim();
  return trimmed ? { authorization: 'Bearer ' + trimmed } : {};
}

export async function searchHfModels(query: string, kind: HfModelKind, token = '', signal?: AbortSignal): Promise<HfModel[]> {
  const payload = await requestJson<HfApiModel[]>(buildSearchUrl(query, kind), {
    label: 'Hugging Face',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 15_000,
    headers: authHeaders(token),
    signal
  });

  if (!Array.isArray(payload)) return [];
  return payload.map((entry) => normaliseHfModel(entry, kind)).filter((entry): entry is HfModel => entry !== null);
}

export function normaliseHfModel(entry: HfApiModel, kind: HfModelKind): HfModel | null {
  const repo = entry.id ?? entry.modelId ?? '';
  if (!repo) return null;

  return {
    id: repo,
    repo,
    label: repo.split('/').pop() ?? repo,
    kind,
    downloads: entry.downloads,
    likes: entry.likes,
    gated: entry.gated === true || typeof entry.gated === 'string'
  };
}

/** Lists the GGUF files in a repo, so a specific quantisation can be pulled. */
export async function listGgufFiles(repo: string, token = '', signal?: AbortSignal): Promise<string[]> {
  const payload = await requestJson<HfApiModel>(HF_API + '/models/' + encodeRepo(repo), {
    label: 'Hugging Face',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 15_000,
    headers: authHeaders(token),
    signal
  });

  return (payload.siblings ?? [])
    .map((sibling) => sibling.rfilename ?? '')
    .filter((name) => name.toLowerCase().endsWith('.gguf'));
}

/** Extracts the quantisation tag from a GGUF filename, e.g. "Q4_K_M". */
export function parseQuant(filename: string): string | null {
  const match = filename.match(/[.-]((?:IQ|Q)\d+(?:_[A-Z0-9]+)*|F16|F32|BF16)\.gguf$/i);
  return match ? match[1].toUpperCase() : null;
}

/** Ranks available quantisations by the preference order Trowser recommends. */
export function pickBestQuant(filenames: string[]): string | null {
  const available = new Set(filenames.map(parseQuant).filter((quant): quant is string => quant !== null));
  for (const preferred of GGUF_QUANTS) {
    if (available.has(preferred)) return preferred;
  }
  return available.values().next().value ?? null;
}

/**
 * Builds the reference Ollama uses to pull a GGUF straight from the Hub.
 * Ollama accepts `hf.co/{org}/{repo}:{quant}`.
 */
export function toOllamaRef(repo: string, quant?: string | null): string {
  const cleaned = repo.trim().replace(/^https?:\/\/(?:huggingface\.co|hf\.co)\//i, '').replace(/\/+$/, '');

  if (!/^[^/]+\/[^/]+$/.test(cleaned)) {
    throw new Error('Expected a Hugging Face repo in "org/name" form, got: ' + repo);
  }

  return 'hf.co/' + cleaned + (quant ? ':' + quant.toUpperCase() : '');
}

/** Verifies a token and returns the account it belongs to. */
export async function hfWhoAmI(token: string, signal?: AbortSignal): Promise<{ name: string; email?: string; avatarUrl?: string }> {
  if (!token.trim()) throw new ProviderHttpError('No Hugging Face token set.', 'Add a token in Trowser options.');

  const payload = await requestJson<HfWhoAmI>(HF_API + '/whoami-v2', {
    label: 'Hugging Face',
    offlineFix: OFFLINE_FIX,
    timeoutMs: 15_000,
    headers: authHeaders(token),
    signal
  });

  if (!payload.name) {
    throw new ProviderHttpError('Hugging Face did not recognise the token.', 'Create a token at https://huggingface.co/settings/tokens');
  }

  return {
    name: payload.fullname || payload.name,
    email: payload.email,
    avatarUrl: payload.avatarUrl ? new URL(payload.avatarUrl, 'https://huggingface.co').toString() : undefined
  };
}

function encodeRepo(repo: string): string {
  return repo
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
