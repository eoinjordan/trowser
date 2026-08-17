/**
 * Page bridge.
 *
 * Injected into the active tab for the duration of a task. It does two things
 * and nothing else: turn the live DOM into a bounded, grounded snapshot, and
 * execute one validated action at a time.
 *
 * There is deliberately no eval, no selector tool and no arbitrary DOM access
 * exposed to the model. The vocabulary here is the whole capability surface.
 */

import type { AgentAction, PageElement, PageSnapshot, ToolResult } from './types';

declare global {
  interface Window {
    __trowserInstalled?: boolean;
  }
}

interface SnapshotRequest {
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

if (!window.__trowserInstalled) {
  window.__trowserInstalled = true;

  chrome.runtime.onMessage.addListener(
    (message: Record<string, unknown>, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (message?.source !== 'trowser') return undefined;

      if (message.type === 'ping') {
        sendResponse({ ok: true });
        return undefined;
      }

      if (message.type === 'snapshot') {
        try {
          sendResponse(captureSnapshot((message.request ?? {}) as SnapshotRequest));
        } catch (error) {
          sendResponse({ __error: describe(error) });
        }
        return undefined;
      }

      if (message.type === 'execute') {
        void executeAction(message.action as AgentAction)
          .then(sendResponse)
          .catch((error: unknown) => sendResponse({ ok: false, message: describe(error) } satisfies ToolResult));
        return true;
      }

      return undefined;
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

/** Walks light and open-shadow DOM, which most component libraries rely on. */
function collectRoots(): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  const queue: Array<Document | ShadowRoot> = [document];

  while (queue.length && roots.length < 60) {
    const root = queue.shift();
    if (!root) break;

    for (const element of Array.from(root.querySelectorAll('*'))) {
      const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow && shadow.mode === 'open') {
        roots.push(shadow);
        queue.push(shadow);
        if (roots.length >= 60) break;
      }
    }
  }

  return roots;
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number(style.opacity) === 0) return false;
  if (element.hasAttribute('inert')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;

  return true;
}

function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function cleanText(value: string | null | undefined, max = 200): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** Resolves an accessible name the way a screen reader roughly would. */
function accessibleName(element: HTMLElement): string | undefined {
  const ariaLabel = cleanText(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
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
 * Structural fingerprint that survives re-renders better than a positional id,
 * used to re-find an element when the DOM shifts between decide and act.
 */
function fingerprint(element: HTMLElement): string {
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

function describeElement(element: HTMLElement, id: string): PageElement {
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
    text: cleanText(element.innerText || element.textContent, 200),
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
 * Extracts readable page text, preferring the main landmark and skipping
 * navigation chrome so the budget is spent on content.
 */
function extractText(budget: number): { text: string; truncated: boolean } {
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
  // Read past the budget so truncation can be reported accurately.
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
 * Ranks elements so the budget goes to what the agent can actually act on:
 * on-screen first, then form controls and links, then everything else.
 */
function rank(element: HTMLElement, inView: boolean): number {
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

function captureSnapshot(request: SnapshotRequest): PageSnapshot {
  const textBudget = clamp(request.textBudget, 500, 40000, 6000);
  const elementBudget = clamp(request.elementBudget, 10, 300, 90);

  const seen = new Set<HTMLElement>();
  const candidates: Array<{ element: HTMLElement; score: number; inView: boolean }> = [];

  for (const root of collectRoots()) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR))) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      const inView = isInViewport(element);
      candidates.push({ element, score: rank(element, inView), inView });
      if (candidates.length >= 600) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, elementBudget);

  // Clear ids from a previous snapshot so a stale id can never resolve.
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

/* -------------------------------------------------------------------------- */
/* Action execution                                                            */
/* -------------------------------------------------------------------------- */

function resolveTarget(action: AgentAction): HTMLElement | null {
  if (!action.targetId) return null;

  for (const root of collectRoots()) {
    const found = root.querySelector<HTMLElement>('[data-trowser-id="' + CSS.escape(action.targetId) + '"]');
    if (found) return found;
  }

  return null;
}

async function executeAction(action: AgentAction): Promise<ToolResult> {
  switch (action.tool) {
    case 'finish':
      return { ok: true, message: action.answer ?? 'Finished.', risk: 'none' };

    case 'ask':
      return { ok: true, message: action.question ?? 'Question for the user.', risk: 'none' };

    case 'wait': {
      const ms = Math.min(action.ms ?? 800, 5000);
      await sleep(ms);
      return { ok: true, message: 'Waited ' + ms + 'ms.', risk: 'none' };
    }

    case 'read': {
      const { text, truncated } = extractText(12000);
      return {
        ok: true,
        message: 'Read ' + text.length + ' characters' + (truncated ? ' (truncated)' : '') + '.',
        data: text,
        risk: 'none'
      };
    }

    case 'scroll': {
      const amount = Math.min(Math.max(action.amount ?? 600, 100), 2000);
      const before = window.scrollY;
      window.scrollBy({ top: action.direction === 'up' ? -amount : amount, behavior: 'instant' as ScrollBehavior });
      await sleep(350);
      const moved = Math.abs(window.scrollY - before);
      return {
        ok: true,
        message: moved < 5 ? 'Already at the ' + (action.direction === 'up' ? 'top' : 'bottom') + ' of the page.' : 'Scrolled ' + (action.direction ?? 'down') + ' ' + moved + 'px.',
        changed: moved >= 5,
        risk: 'none'
      };
    }

    case 'back': {
      history.back();
      await sleep(600);
      return { ok: true, message: 'Navigated back.', changed: true, risk: 'none' };
    }

    case 'key': {
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      dispatchKey(target, action.key ?? 'Enter');
      await sleep(300);
      return { ok: true, message: 'Pressed ' + action.key + '.', changed: true };
    }

    default:
      break;
  }

  const target = resolveTarget(action);
  if (!target) {
    return { ok: false, message: 'Element ' + (action.targetId ?? '(missing)') + ' is no longer on the page. Take a fresh look.' };
  }

  if (!isVisible(target)) {
    return { ok: false, message: 'Element ' + action.targetId + ' is not visible.' };
  }

  switch (action.tool) {
    case 'click':
      return clickElement(target, action);
    case 'type':
      return typeIntoElement(target, action);
    case 'select':
      return selectOption(target, action);
    default:
      return { ok: false, message: 'Unsupported tool: ' + action.tool };
  }
}

async function clickElement(target: HTMLElement, action: AgentAction): Promise<ToolResult> {
  const urlBefore = location.href;

  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  await sleep(60);

  // Some frameworks only respond to the full pointer sequence.
  const rect = target.getBoundingClientRect();
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true };

  target.dispatchEvent(new PointerEvent('pointerdown', { ...point, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousedown', point));
  try {
    target.focus({ preventScroll: true });
  } catch {
    // Focus can throw on detached or inert nodes; the click still applies.
  }
  target.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseup', point));
  target.click();

  await sleep(450);

  const navigated = location.href !== urlBefore;
  return {
    ok: true,
    message: 'Clicked ' + action.targetId + (navigated ? '; page navigated to ' + location.href : '.'),
    changed: true
  };
}

async function typeIntoElement(target: HTMLElement, action: AgentAction): Promise<ToolResult> {
  const input = target instanceof HTMLInputElement ? target : undefined;
  const textarea = target instanceof HTMLTextAreaElement ? target : undefined;

  // Defence in depth: the policy engine blocks these too, but the executor is
  // the last line and must never depend on an upstream check.
  if (input && (input.type === 'password' || input.type === 'file')) {
    return { ok: false, message: 'Typing into ' + input.type + ' fields is blocked.', risk: 'blocked' };
  }

  if (!input && !textarea && !target.isContentEditable) {
    return { ok: false, message: action.targetId + ' is not a text field.' };
  }

  const text = action.text ?? '';
  target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  target.focus({ preventScroll: true });

  if (input || textarea) {
    const field = (input ?? textarea) as HTMLInputElement | HTMLTextAreaElement;
    // React tracks the value on the DOM node, so the native setter must be
    // used or the framework will revert the change on its next render.
    const prototype = textarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    setter ? setter.call(field, text) : (field.value = text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    target.textContent = text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  if (action.submit) {
    await sleep(120);
    dispatchKey(target, 'Enter');
    await sleep(500);
    return { ok: true, message: 'Typed into ' + action.targetId + ' and pressed Enter.', changed: true };
  }

  return { ok: true, message: 'Typed into ' + action.targetId + '.', changed: true };
}

async function selectOption(target: HTMLElement, action: AgentAction): Promise<ToolResult> {
  if (!(target instanceof HTMLSelectElement)) {
    return { ok: false, message: action.targetId + ' is not a select element.' };
  }

  const wanted = action.value ?? '';
  const match =
    Array.from(target.options).find((option) => option.value === wanted) ??
    Array.from(target.options).find((option) => option.text.trim().toLowerCase() === wanted.trim().toLowerCase());

  if (!match) {
    const available = Array.from(target.options)
      .slice(0, 20)
      .map((option) => option.value)
      .join(', ');
    return { ok: false, message: 'No option "' + wanted + '" in ' + action.targetId + '. Available: ' + available };
  }

  target.value = match.value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, message: 'Selected "' + match.text.trim() + '" in ' + action.targetId + '.', changed: true };
}

function dispatchKey(target: HTMLElement, key: string): void {
  const init: KeyboardEventInit = {
    key,
    code: key === 'Enter' ? 'Enter' : key,
    bubbles: true,
    cancelable: true,
    ...(key === 'Enter' ? { keyCode: 13, which: 13 } : {})
  } as KeyboardEventInit;

  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  // Enter inside a single-input form should submit it, matching browser behaviour.
  if (key === 'Enter') {
    const form = target.closest('form');
    if (form && !form.querySelector('button[type="submit"], input[type="submit"]')) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
