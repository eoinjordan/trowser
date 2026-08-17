/** Shared fixtures for the test suite. */

import type { AgentConfig, PageElement, PageSnapshot } from '../src/types';

export function makeElement(overrides: Partial<PageElement> & { id: string }): PageElement {
  return {
    fp: 'fp-' + overrides.id,
    tag: 'button',
    inView: true,
    ...overrides
  };
}

export function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  const elements = overrides.elements ?? [
    makeElement({ id: 'e1', tag: 'a', text: 'Pricing', href: 'https://example.com/pricing' }),
    makeElement({ id: 'e2', tag: 'button', text: 'Buy now' }),
    makeElement({ id: 'e3', tag: 'input', type: 'text', placeholder: 'Search', inForm: true })
  ];

  return {
    title: 'Example',
    url: 'https://example.com/',
    origin: 'https://example.com',
    text: 'Example page text.',
    textTruncated: false,
    elements,
    totalElements: elements.length,
    scroll: { y: 0, height: 2000, viewport: 800 },
    capturedAt: 1_700_000_000_000,
    ...overrides
  };
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    maxSteps: 16,
    approveEverything: false,
    allowCrossOrigin: false,
    trustedOrigins: [],
    textBudget: 6000,
    elementBudget: 90,
    ...overrides
  };
}
