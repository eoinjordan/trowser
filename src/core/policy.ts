/**
 * Capability policy.
 *
 * The agent loop never decides on its own whether an action is safe. Every
 * action passes through `assessAction`, which is a pure function of the action,
 * the snapshot it was grounded in, and the user's configuration. Keeping it
 * pure means the whole policy surface is unit-testable without a browser.
 */

import type { AgentAction, AgentConfig, PageElement, PageSnapshot, RiskLevel } from '../types';

export interface PolicyDecision {
  risk: RiskLevel;
  /** Short explanation shown in the approval prompt and the trace. */
  reason: string;
  requiresApproval: boolean;
}

/** Irreversible or account-level controls. Never auto-approved. */
const DESTRUCTIVE_PATTERN =
  /\b(delete|delete all|remove|erase|destroy|wipe|revoke|deactivate|terminate|unsubscribe|cancel (?:subscription|plan|order|booking)|close account|delete account|sign out|log out|logout)\b/;

/** Consequential but routine controls. Auto-approvable on trusted origins. */
const SENSITIVE_PATTERN =
  /\b(pay|payment|purchase|buy|buy now|order|checkout|place order|send|submit|post|publish|share|confirm|book|reserve|apply|donate|transfer|withdraw|deposit|subscribe|upgrade|renew|accept|agree|install)\b/;

/** Input types that must never be automated, regardless of configuration. */
const BLOCKED_INPUT_TYPES = new Set(['password', 'file']);

/** Input types that carry personal data. */
const PERSONAL_INPUT_TYPES = new Set(['email', 'tel']);

/** Tools that cannot change page or account state. */
const READ_ONLY_TOOLS = new Set<AgentAction['tool']>(['read', 'scroll', 'wait', 'finish', 'ask']);

export function assessAction(action: AgentAction, snapshot: PageSnapshot, config: AgentConfig): PolicyDecision {
  const target = action.targetId ? snapshot.elements.find((element) => element.id === action.targetId) : undefined;

  const hardBlock = findHardBlock(action, target);
  if (hardBlock) return { risk: 'blocked', reason: hardBlock, requiresApproval: false };

  if (READ_ONLY_TOOLS.has(action.tool)) {
    return { risk: 'none', reason: 'Read-only action.', requiresApproval: false };
  }

  const trusted = isTrustedOrigin(snapshot.origin, config.trustedOrigins);
  const raw = classify(action, target, snapshot);

  if (raw.risk === 'destructive') {
    // Destructive actions always stop for a human, trusted origin or not.
    return { ...raw, requiresApproval: true };
  }

  if (raw.risk === 'sensitive') {
    return { ...raw, requiresApproval: !trusted };
  }

  return { ...raw, requiresApproval: config.approveEverything };
}

function findHardBlock(action: AgentAction, target?: PageElement): string | null {
  if (action.tool === 'type') {
    if (target && BLOCKED_INPUT_TYPES.has(target.type ?? '')) {
      return 'Trowser never types into ' + target.type + ' fields.';
    }
    const secret = detectSecret(action.text ?? '');
    if (secret) return 'Blocked: the text looks like ' + secret + '. Trowser does not enter credentials or payment details.';
  }

  if (action.tool === 'navigate' && action.url) {
    try {
      const protocol = new URL(action.url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return 'Blocked URL scheme: ' + protocol;
    } catch {
      return 'Blocked: malformed navigation URL.';
    }
  }

  if (target?.disabled && (action.tool === 'click' || action.tool === 'type' || action.tool === 'select')) {
    return 'Element ' + target.id + ' is disabled.';
  }

  return null;
}

function classify(action: AgentAction, target: PageElement | undefined, snapshot: PageSnapshot): Omit<PolicyDecision, 'requiresApproval'> {
  if (action.tool === 'navigate' && action.url) {
    const sameOrigin = safeOrigin(action.url) === snapshot.origin;
    return sameOrigin
      ? { risk: 'none', reason: 'Same-origin navigation.' }
      : { risk: 'sensitive', reason: 'Navigates to a different site.' };
  }

  if (action.tool === 'back') {
    return { risk: 'none', reason: 'History navigation.' };
  }

  if (action.tool === 'key' && action.key === 'Enter') {
    return { risk: 'sensitive', reason: 'Enter can submit the focused form.' };
  }

  if (!target) {
    return { risk: 'none', reason: 'No targeted element.' };
  }

  const label = elementLabel(target);

  if (DESTRUCTIVE_PATTERN.test(label)) {
    return { risk: 'destructive', reason: 'Control looks destructive: "' + trim(label) + '".' };
  }

  if (SENSITIVE_PATTERN.test(label)) {
    return { risk: 'sensitive', reason: 'Control looks consequential: "' + trim(label) + '".' };
  }

  if (action.tool === 'click' && isSubmitControl(target)) {
    return { risk: 'sensitive', reason: 'Submits a form.' };
  }

  if (action.tool === 'type' && PERSONAL_INPUT_TYPES.has(target.type ?? '')) {
    return { risk: 'sensitive', reason: 'Enters personal data into a ' + target.type + ' field.' };
  }

  if (action.tool === 'type' && action.submit) {
    return { risk: 'sensitive', reason: 'Types and then submits.' };
  }

  return { risk: 'none', reason: 'Routine interaction.' };
}

export function elementLabel(element: PageElement): string {
  return [element.text, element.ariaLabel, element.placeholder, element.name].filter(Boolean).join(' ').toLowerCase();
}

function isSubmitControl(element: PageElement): boolean {
  if (element.type === 'submit' || element.type === 'image') return true;
  return Boolean(element.inForm) && element.tag === 'button' && element.type !== 'button';
}

/**
 * Detects secrets that must never be typed into a page. Returns a short
 * description of what was matched, or null.
 */
export function detectSecret(text: string): string | null {
  const value = text.trim();
  if (!value) return null;

  const digits = value.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return 'a payment card number';

  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return 'a social security number';

  if (/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/.test(value.replace(/\s/g, ''))) return 'an IBAN';

  if (/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(value)) {
    return 'an API key or access token';
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return 'a private key';

  return null;
}

/** Standard Luhn checksum, used to avoid flagging ordinary long numbers. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

export function isTrustedOrigin(origin: string, trustedOrigins: string[]): boolean {
  if (!origin) return false;
  return trustedOrigins.some((entry) => entry.trim().toLowerCase() === origin.toLowerCase());
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function trim(label: string): string {
  return label.length > 60 ? label.slice(0, 57) + '...' : label;
}
