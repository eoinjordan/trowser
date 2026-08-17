/**
 * jsdom harness.
 *
 * jsdom performs no layout, so every getBoundingClientRect returns zeros and
 * the visibility filter would reject the entire page. The stub below gives
 * elements a plausible box, and honours two test hooks:
 *
 *   data-test-rect="top,left,width,height"  explicit geometry
 *   data-test-hidden                        zero-sized, i.e. not rendered
 */

import { JSDOM } from 'jsdom';

export interface DomHandle {
  dom: JSDOM;
  cleanup(): void;
}

const VIEWPORT = { width: 1280, height: 800 };

export function setupDom(html: string, url = 'https://example.com/'): DomHandle {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;

  window.Element.prototype.getBoundingClientRect = function boundingRect(this: Element): DOMRect {
    const element = this as HTMLElement;

    if (element.hasAttribute?.('data-test-hidden')) return rect(0, 0, 0, 0);

    const explicit = element.getAttribute?.('data-test-rect');
    if (explicit) {
      const [top, left, width, height] = explicit.split(',').map(Number);
      return rect(top, left, width, height);
    }

    // Default: a modest visible box near the top of the viewport.
    return rect(10, 10, 120, 30);
  };

  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};

  // jsdom implements neither scrolling nor a scroll height.
  let scrollY = 0;
  Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
  window.scrollBy = ((options: ScrollToOptions | number) => {
    const top = typeof options === 'number' ? options : (options?.top ?? 0);
    scrollY = Math.max(0, scrollY + top);
  }) as typeof window.scrollBy;
  Object.defineProperty(window.document.documentElement, 'scrollHeight', { value: 4000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });

  installGlobals(window);

  return {
    dom,
    cleanup() {
      dom.window.close();
    }
  };

  function rect(top: number, left: number, width: number, height: number): DOMRect {
    return {
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({})
    } as DOMRect;
  }
}

/** Copies the jsdom window onto globalThis so modules see a browser. */
function installGlobals(window: JSDOM['window']): void {
  const globals = [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'getComputedStyle',
    'NodeFilter',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLAnchorElement',
    'HTMLImageElement',
    'HTMLButtonElement',
    'Event',
    'InputEvent',
    'KeyboardEvent',
    'MouseEvent',
    'CustomEvent',
    'CSS'
  ] as const;

  for (const key of globals) {
    const value = (window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  }

  // jsdom does not implement CSS.escape.
  if (!(globalThis as { CSS?: { escape?: unknown } }).CSS?.escape) {
    Object.defineProperty(globalThis, 'CSS', {
      value: { escape: (value: string) => value.replace(/["\\\]]/g, '\\$&') },
      configurable: true,
      writable: true
    });
  }

  // PointerEvent is absent in jsdom; the executor falls back to MouseEvent.
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    Object.defineProperty(globalThis, 'PointerEvent', { value: undefined, configurable: true, writable: true });
  }
}
