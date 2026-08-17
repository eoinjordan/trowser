/**
 * DOM observation.
 *
 * Deliberately free of Chrome APIs: it touches only standard DOM, so the whole
 * snapshot pipeline can be tested against a real document. `content.ts` is the
 * thin wrapper that connects this to chrome.runtime messaging.
 */

import type { PageElement, PageSnapshot } from '../types';

export interface SnapshotRequest {
  textBudget: number;
  elementBudget: number;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** Containers whose text is never useful to the model. */
const TEXT_EXCLUDED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME', 'CANVAS']);

const MAX_ROOTS = 60;
const MAX_CANDIDATES = 600;

/** Walks light DOM and open shadow roots, which component libraries rely on. */
export function collectRoots(root: Document | ShadowRoot = document): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [root];
  const queue: Array<Document | ShadowRoot> = [root];

  while (queue.length && roots.length < MAX_ROOTS) {
    const current = queue.shift();
    if (!current) break;

    for (const element of Array.from(current.querySelectorAll('*'))) {
      const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      // Closed shadow roots are invisible to us by design.
      if (shadow && shadow.mode === 'open') {
        roots.push(shadow);
        queue.push(shadow);
        if (roots.length >= MAX_ROOTS) break;
      }
    }
  }

  return roots;
}

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  if (element.hasAttribute('inert')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;

  return true;
}

export function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export function cleanText(value: string | null | undefined, max = 200): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** Resolves an accessible name roughly the way a screen reader would. */
export function accessibleName(element: HTMLElement): string | undefined {
  const ariaLabel = cleanText(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = element.ownerDocument;
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ');
    const resolved = cleanText(parts);
    if (resolved) return resolved;
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const labels = Array.from(element.labels ?? []);
    const labelText = cleanText(labels.map((label) => label.textContent).join(' '));
    if (labelText) return labelText;
  }

  const title = cleanText(element.getAttribute('title'));
  if (title) return title;

  if (element instanceof HTMLImageElement) {
    const alt = cleanText(element.alt);
    if (alt) return alt;
  }

  // An icon-only button often carries its name on a nested image.
  const nestedAlt = cleanText(element.querySelector('img[alt]')?.getAttribute('alt'));
  if (nestedAlt) return nestedAlt;

  return undefined;
}

/**
 * Structural fingerprint that survives re-renders better than a positional
 * index, used to recognise an element after the DOM shifts.
 */
export function fingerprint(element: HTMLElement): string {
  const path: string[] = [];
  let node: Element | null = element;
  let depth = 0;

  while (node && depth < 6) {
    const parent: Element | null = node.parentElement;
    const index = parent ? Array.from(parent.children).indexOf(node) : 0;
    path.push(node.tagName.toLowerCase() + index);
    node = parent;
    depth += 1;
  }

  const name = accessibleName(element) ?? cleanText(element.textContent, 40) ?? '';
  return hash(path.reverse().join('>') + '|' + element.tagName + '|' + name);
}

function hash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

export function describeElement(element: HTMLElement, id: string): PageElement {
  const input = element instanceof HTMLInputElement ? element : undefined;
  const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
  const select = element instanceof HTMLSelectElement ? element : undefined;
  const isPassword = input?.type === 'password';

  const rawValue = input?.value ?? textarea?.value ?? select?.value;

  return {
    id,
    fp: fingerprint(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') ?? undefined,
    type: input?.type,
    name: cleanText(element.getAttribute('name'), 60),
    text: cleanText(element.textContent, 200),
    ariaLabel: accessibleName(element),
    placeholder: cleanText(input?.placeholder ?? textarea?.placeholder),
    // A password value is never read, not even in redacted form.
    value: isPassword ? '[redacted]' : cleanText(rawValue, 120),
    checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : undefined,
    disabled: 'disabled' in element ? Boolean((element as HTMLButtonElement).disabled) : undefined,
    required: input?.required || textarea?.required || select?.required || undefined,
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    inForm: Boolean(element.closest('form')),
    inView: isInViewport(element),
    options: select
      ? Array.from(select.options)
          .slice(0, 40)
          .map((option) => ({ value: option.value, label: cleanText(option.text, 60) ?? option.value }))
      : undefined
  };
}

/**
 * Extracts readable page text, preferring the main landmark so the budget is
 * spent on content rather than navigation chrome.
 */
export function extractText(budget: number): { text: string; truncated: boolean } {
  const container =
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.querySelector('article') ??
    document.body;

  if (!container) return { text: '', truncated: false };

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = node.parentElement;
      if (!parent || TEXT_EXCLUDED.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const parts: string[] = [];
  let length = 0;
  // Read a little past the budget so truncation is reported accurately.
  const ceiling = budget + 1000;

  for (let node = walker.nextNode(); node && length < ceiling; node = walker.nextNode()) {
    const value = node.textContent?.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    parts.push(value);
    length += value.length + 1;
  }

  const joined = parts.join(' ');
  return joined.length > budget ? { text: joined.slice(0, budget), truncated: true } : { text: joined, truncated: false };
}

/**
 * Ranks elements so a limited budget is spent on what the agent can act on:
 * on-screen first, then form controls and links, then everything else.
 */
export function rank(element: HTMLElement, inView: boolean): number {
  let score = inView ? 1000 : 0;

  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea') score += 50;
  if (tag === 'input') score += 60;
  if (element.closest('form')) score += 25;
  if (accessibleName(element)) score += 20;
  if ('disabled' in element && (element as HTMLButtonElement).disabled) score -= 40;

  // Prefer elements nearer the top of the viewport.
  const top = element.getBoundingClientRect().top;
  score -= Math.min(Math.abs(top) / 100, 20);

  return score;
}

export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

export function captureSnapshot(request: Partial<SnapshotRequest> = {}): PageSnapshot {
  const textBudget = clamp(request.textBudget, 500, 40000, 6000);
  const elementBudget = clamp(request.elementBudget, 10, 300, 90);

  const seen = new Set<HTMLElement>();
  const candidates: Array<{ element: HTMLElement; score: number }> = [];

  for (const root of collectRoots()) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR))) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      candidates.push({ element, score: rank(element, isInViewport(element)) });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, elementBudget);

  // Clear ids from a previous snapshot so a stale id can never resolve to a
  // different element than the model was shown.
  for (const stale of Array.from(document.querySelectorAll<HTMLElement>('[data-trowser-id]'))) {
    delete stale.dataset.trowserId;
  }

  const elements = chosen.map((candidate, index) => {
    const id = 'e' + (index + 1);
    candidate.element.dataset.trowserId = id;
    return describeElement(candidate.element, id);
  });

  const { text, truncated } = extractText(textBudget);

  return {
    title: document.title,
    url: location.href,
    origin: location.origin,
    text,
    textTruncated: truncated,
    elements,
    totalElements: candidates.length,
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewport: Math.round(window.innerHeight)
    },
    capturedAt: Date.now()
  };
}
