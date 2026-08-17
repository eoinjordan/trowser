/**
 * The action contract shared by every backend.
 *
 * `ACTION_SCHEMA` is handed to backends that support constrained decoding
 * (Chrome's Prompt API, Ollama's `format`, OpenAI-compatible `json_schema`).
 * `validateAction` is the runtime gate every action must pass regardless of
 * whether the backend honoured the schema, because a local 1B model often
 * will not.
 */

import type { AgentAction, ToolName } from '../types';

export const TOOL_NAMES: ToolName[] = [
  'click',
  'type',
  'select',
  'scroll',
  'key',
  'navigate',
  'back',
  'read',
  'wait',
  'ask',
  'finish'
];

/** Tools whose `targetId` must resolve to an element in the current snapshot. */
export const TARGETED_TOOLS = new Set<ToolName>(['click', 'type', 'select']);

export const ALLOWED_KEYS = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'Backspace'];

export const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: TOOL_NAMES },
    targetId: { type: 'string', description: 'Element id from the snapshot, e.g. "e7". Required for click, type and select.' },
    text: { type: 'string', description: 'Text to type. Only for the type tool.' },
    value: { type: 'string', description: 'Option value. Only for the select tool.' },
    url: { type: 'string', description: 'Absolute http(s) URL. Only for the navigate tool.' },
    key: { type: 'string', enum: ALLOWED_KEYS },
    direction: { type: 'string', enum: ['up', 'down'] },
    amount: { type: 'number' },
    ms: { type: 'number' },
    submit: { type: 'boolean', description: 'Press Enter after typing.' },
    question: { type: 'string', description: 'Question for the user. Only for the ask tool.' },
    answer: { type: 'string', description: 'Final answer. Only for the finish tool.' },
    reason: { type: 'string', description: 'One short sentence explaining this step.' }
  },
  required: ['tool', 'reason']
} as const;

export class ActionValidationError extends Error {
  constructor(
    message: string,
    /** Hint fed back to the model so it can repair its next attempt. */
    readonly hint: string
  ) {
    super(message);
    this.name = 'ActionValidationError';
  }
}

export interface ValidateOptions {
  elementIds: Set<string> | string[];
  allowCrossOrigin: boolean;
  currentOrigin: string;
}

const MAX_TEXT_LENGTH = 2000;

/**
 * Normalises and validates a decoded action. Returns a clean action, or throws
 * an ActionValidationError carrying a repair hint for the next attempt.
 */
export function validateAction(raw: unknown, options: ValidateOptions): AgentAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ActionValidationError('Action was not a JSON object.', 'Reply with a single JSON object and nothing else.');
  }

  const candidate = raw as Record<string, unknown>;
  const tool = typeof candidate.tool === 'string' ? (candidate.tool.trim().toLowerCase() as ToolName) : undefined;

  if (!tool || !TOOL_NAMES.includes(tool)) {
    throw new ActionValidationError(
      'Unknown tool: ' + String(candidate.tool),
      '"tool" must be one of: ' + TOOL_NAMES.join(', ') + '.'
    );
  }

  const reason =
    typeof candidate.reason === 'string' && candidate.reason.trim()
      ? candidate.reason.trim().slice(0, 300)
      : 'No reason given.';

  const action: AgentAction = { tool, reason };
  const ids = options.elementIds instanceof Set ? options.elementIds : new Set(options.elementIds);

  if (TARGETED_TOOLS.has(tool)) {
    const targetId = typeof candidate.targetId === 'string' ? candidate.targetId.trim() : '';
    if (!targetId) {
      throw new ActionValidationError(
        tool + ' requires targetId.',
        'The ' + tool + ' tool needs a "targetId" copied exactly from the ELEMENTS list.'
      );
    }
    if (!ids.has(targetId)) {
      throw new ActionValidationError(
        'Element ' + targetId + ' is not in the current snapshot.',
        '"' + targetId + '" is not on this page. Use an id that appears in the ELEMENTS list, or scroll to reveal more.'
      );
    }
    action.targetId = targetId;
  }

  switch (tool) {
    case 'type': {
      if (typeof candidate.text !== 'string') {
        throw new ActionValidationError('type requires text.', 'The type tool needs a "text" string.');
      }
      action.text = candidate.text.slice(0, MAX_TEXT_LENGTH);
      action.submit = candidate.submit === true;
      break;
    }
    case 'select': {
      if (typeof candidate.value !== 'string') {
        throw new ActionValidationError(
          'select requires value.',
          'The select tool needs a "value" string taken from that element\'s options.'
        );
      }
      action.value = candidate.value;
      break;
    }
    case 'navigate': {
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      action.url = normaliseUrl(url, options);
      break;
    }
    case 'key': {
      const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
      const match = ALLOWED_KEYS.find((allowed) => allowed.toLowerCase() === key.toLowerCase());
      if (!match) {
        throw new ActionValidationError(
          'Key ' + (key || '(missing)') + ' is not allowed.',
          '"key" must be one of: ' + ALLOWED_KEYS.join(', ') + '.'
        );
      }
      action.key = match;
      break;
    }
    case 'scroll': {
      action.direction = candidate.direction === 'up' ? 'up' : 'down';
      action.amount = clampNumber(candidate.amount, 100, 2000, 600);
      break;
    }
    case 'wait': {
      action.ms = clampNumber(candidate.ms, 100, 5000, 800);
      break;
    }
    case 'ask': {
      const question = typeof candidate.question === 'string' ? candidate.question.trim() : '';
      if (!question) {
        throw new ActionValidationError('ask requires a question.', 'The ask tool needs a "question" string for the user.');
      }
      action.question = question.slice(0, 500);
      break;
    }
    case 'finish': {
      const answer = typeof candidate.answer === 'string' ? candidate.answer.trim() : '';
      action.answer = (answer || reason).slice(0, 4000);
      break;
    }
    default:
      break;
  }

  return action;
}

function normaliseUrl(url: string, options: ValidateOptions): string {
  if (!url) {
    throw new ActionValidationError('navigate requires url.', 'The navigate tool needs an absolute "url" starting with https://.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ActionValidationError('Malformed URL: ' + url, 'Provide an absolute URL including the https:// scheme.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ActionValidationError(
      'Blocked URL scheme: ' + parsed.protocol,
      'Only http and https URLs are allowed. javascript:, data: and file: are blocked.'
    );
  }

  if (!options.allowCrossOrigin && options.currentOrigin && parsed.origin !== options.currentOrigin) {
    throw new ActionValidationError(
      'Cross-origin navigation to ' + parsed.origin + ' is disabled.',
      'Cross-origin navigation is off. Stay on ' + options.currentOrigin + ' or finish and tell the user what you need.'
    );
  }

  return parsed.toString();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}
