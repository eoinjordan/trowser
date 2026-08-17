/**
 * Action execution.
 *
 * The last line of defence. Chrome-API free so the whole executor can be tested
 * against a real document, and it independently re-checks the blocks the policy
 * engine already applies, so a bug in one layer does not defeat both.
 */

import type { AgentAction, ToolResult } from '../types';
import { collectRoots, extractText, isVisible } from './snapshot';

export const READ_TOOL_BUDGET = 12000;

export function resolveTarget(action: AgentAction): HTMLElement | null {
  if (!action.targetId) return null;

  for (const root of collectRoots()) {
    const found = root.querySelector<HTMLElement>('[data-trowser-id="' + CSS.escape(action.targetId) + '"]');
    if (found) return found;
  }

  return null;
}

export async function executeAction(action: AgentAction, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<ToolResult> {
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
      const { text, truncated } = extractText(READ_TOOL_BUDGET);
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
      window.scrollBy({ top: action.direction === 'up' ? -amount : amount });
      await sleep(350);

      const moved = Math.abs(window.scrollY - before);
      return {
        ok: true,
        message: moved < 5
          ? 'Already at the ' + (action.direction === 'up' ? 'top' : 'bottom') + ' of the page.'
          : 'Scrolled ' + (action.direction ?? 'down') + ' ' + moved + 'px.',
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
      return clickElement(target, action, sleep);
    case 'type':
      return typeIntoElement(target, action, sleep);
    case 'select':
      return selectOption(target, action);
    default:
      return { ok: false, message: 'Unsupported tool: ' + action.tool };
  }
}

async function clickElement(target: HTMLElement, action: AgentAction, sleep: (ms: number) => Promise<void>): Promise<ToolResult> {
  const urlBefore = location.href;

  target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  await sleep(60);

  // Some frameworks only respond to the full pointer sequence.
  const rect = target.getBoundingClientRect();
  const point = {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    bubbles: true,
    cancelable: true
  };

  dispatchPointer(target, 'pointerdown', point);
  target.dispatchEvent(new MouseEvent('mousedown', point));
  try {
    target.focus({ preventScroll: true });
  } catch {
    // Focus can throw on detached or inert nodes; the click still applies.
  }
  dispatchPointer(target, 'pointerup', point);
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

async function typeIntoElement(target: HTMLElement, action: AgentAction, sleep: (ms: number) => Promise<void>): Promise<ToolResult> {
  const input = target instanceof HTMLInputElement ? target : undefined;
  const textarea = target instanceof HTMLTextAreaElement ? target : undefined;

  // Defence in depth: the policy engine blocks these too, but the executor must
  // never depend on an upstream check having run.
  if (input && (input.type === 'password' || input.type === 'file')) {
    return { ok: false, message: 'Typing into ' + input.type + ' fields is blocked.', risk: 'blocked' };
  }

  if (!input && !textarea && !target.isContentEditable) {
    return { ok: false, message: action.targetId + ' is not a text field.' };
  }

  const text = action.text ?? '';
  target.scrollIntoView?.({ block: 'center' });
  target.focus({ preventScroll: true });

  if (input || textarea) {
    const field = (input ?? textarea) as HTMLInputElement | HTMLTextAreaElement;
    // React tracks value on the DOM node, so the native setter must be used or
    // the framework reverts the change on its next render.
    const prototype = textarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (setter) setter.call(field, text);
    else field.value = text;

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

function selectOption(target: HTMLElement, action: AgentAction): ToolResult {
  if (!(target instanceof HTMLSelectElement)) {
    return { ok: false, message: action.targetId + ' is not a select element.' };
  }

  const wanted = action.value ?? '';
  const options = Array.from(target.options);

  // Match on value first, then on visible label, because a model reading the
  // page often reproduces the label rather than the underlying value.
  const match =
    options.find((option) => option.value === wanted) ??
    options.find((option) => option.text.trim().toLowerCase() === wanted.trim().toLowerCase());

  if (!match) {
    const available = options.slice(0, 20).map((option) => option.value).join(', ');
    return { ok: false, message: 'No option "' + wanted + '" in ' + action.targetId + '. Available: ' + available };
  }

  target.value = match.value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, message: 'Selected "' + match.text.trim() + '" in ' + action.targetId + '.', changed: true };
}

function dispatchPointer(target: HTMLElement, type: string, point: Record<string, unknown>): void {
  // PointerEvent is absent in some environments; MouseEvent is a valid fallback.
  const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  target.dispatchEvent(new Ctor(type, { ...point, bubbles: true, cancelable: true } as MouseEventInit));
}

export function dispatchKey(target: HTMLElement, key: string): void {
  const init = {
    key,
    code: key === 'Enter' ? 'Enter' : key,
    bubbles: true,
    cancelable: true,
    ...(key === 'Enter' ? { keyCode: 13, which: 13 } : {})
  } as KeyboardEventInit;

  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  // Enter in a form with no submit control should submit it, matching browsers.
  if (key === 'Enter') {
    const form = target.closest('form');
    if (form && !form.querySelector('button[type="submit"], input[type="submit"]')) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
