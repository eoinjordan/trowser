import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ACTION_SCHEMA, ActionValidationError, TOOL_NAMES, validateAction } from '../src/core/schema';

const baseOptions = {
  elementIds: ['e1', 'e2', 'e3'],
  allowCrossOrigin: false,
  currentOrigin: 'https://example.com'
};

function expectError(input: unknown, options = baseOptions): ActionValidationError {
  try {
    validateAction(input, options);
  } catch (error) {
    assert.ok(error instanceof ActionValidationError, 'expected ActionValidationError, got ' + String(error));
    return error;
  }
  throw new Error('Expected validateAction to throw for ' + JSON.stringify(input));
}

describe('validateAction: shape', () => {
  it('rejects non-objects', () => {
    for (const input of [null, undefined, 42, 'click', [], true]) {
      const error = expectError(input);
      assert.match(error.hint, /single JSON object|tool" must be/);
    }
  });

  it('rejects unknown tools with a hint listing valid tools', () => {
    const error = expectError({ tool: 'exec', reason: 'run code' });
    assert.match(error.hint, /click/);
    assert.match(error.hint, /finish/);
  });

  it('accepts every declared tool name in the schema enum', () => {
    assert.deepEqual([...ACTION_SCHEMA.properties.tool.enum], TOOL_NAMES);
  });

  it('lower-cases and trims the tool name', () => {
    const action = validateAction({ tool: '  CLICK ', targetId: 'e1', reason: 'go' }, baseOptions);
    assert.equal(action.tool, 'click');
  });

  it('substitutes a placeholder when reason is missing', () => {
    const action = validateAction({ tool: 'back' }, baseOptions);
    assert.equal(action.reason, 'No reason given.');
  });

  it('truncates an overlong reason', () => {
    const action = validateAction({ tool: 'back', reason: 'x'.repeat(600) }, baseOptions);
    assert.equal(action.reason.length, 300);
  });
});

describe('validateAction: element grounding', () => {
  it('requires targetId for click, type and select', () => {
    assert.match(expectError({ tool: 'click', reason: 'go' }).hint, /targetId/);
    assert.match(expectError({ tool: 'type', text: 'hi', reason: 'go' }).hint, /targetId/);
    assert.match(expectError({ tool: 'select', value: 'IE', reason: 'go' }).hint, /targetId/);
  });

  it('rejects hallucinated element ids', () => {
    const error = expectError({ tool: 'click', targetId: 'e99', reason: 'go' });
    assert.match(error.message, /not in the current snapshot/);
    assert.match(error.hint, /e99/);
  });

  it('rejects CSS selectors passed as ids', () => {
    expectError({ tool: 'click', targetId: 'button.primary', reason: 'go' });
    expectError({ tool: 'click', targetId: '#submit', reason: 'go' });
  });

  it('accepts a Set of ids as well as an array', () => {
    const action = validateAction(
      { tool: 'click', targetId: 'e2', reason: 'go' },
      { ...baseOptions, elementIds: new Set(['e2']) }
    );
    assert.equal(action.targetId, 'e2');
  });

  it('does not require targetId for untargeted tools', () => {
    for (const tool of ['scroll', 'wait', 'back', 'read', 'finish']) {
      const action = validateAction({ tool, reason: 'go', answer: 'done', question: 'q' }, baseOptions);
      assert.equal(action.targetId, undefined);
    }
  });
});

describe('validateAction: type', () => {
  it('requires text', () => {
    assert.match(expectError({ tool: 'type', targetId: 'e1', reason: 'go' }).hint, /"text"/);
  });

  it('caps text length at 2000 characters', () => {
    const action = validateAction({ tool: 'type', targetId: 'e1', text: 'a'.repeat(5000), reason: 'go' }, baseOptions);
    assert.equal(action.text?.length, 2000);
  });

  it('defaults submit to false and only honours a real boolean', () => {
    assert.equal(validateAction({ tool: 'type', targetId: 'e1', text: 'x', reason: 'r' }, baseOptions).submit, false);
    assert.equal(validateAction({ tool: 'type', targetId: 'e1', text: 'x', submit: 'yes', reason: 'r' }, baseOptions).submit, false);
    assert.equal(validateAction({ tool: 'type', targetId: 'e1', text: 'x', submit: true, reason: 'r' }, baseOptions).submit, true);
  });

  it('preserves an empty string, which clears a field', () => {
    const action = validateAction({ tool: 'type', targetId: 'e1', text: '', reason: 'clear' }, baseOptions);
    assert.equal(action.text, '');
  });
});

describe('validateAction: navigate', () => {
  it('blocks javascript, data and file schemes', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///etc/passwd', 'chrome://settings']) {
      const error = expectError({ tool: 'navigate', url, reason: 'go' });
      assert.match(error.message, /Blocked URL scheme|Malformed URL/);
    }
  });

  it('blocks cross-origin navigation when disabled', () => {
    const error = expectError({ tool: 'navigate', url: 'https://evil.test/steal', reason: 'go' });
    assert.match(error.message, /Cross-origin/);
    assert.match(error.hint, /https:\/\/example\.com/);
  });

  it('allows cross-origin navigation when enabled', () => {
    const action = validateAction(
      { tool: 'navigate', url: 'https://other.test/docs', reason: 'go' },
      { ...baseOptions, allowCrossOrigin: true }
    );
    assert.equal(action.url, 'https://other.test/docs');
  });

  it('allows same-origin navigation regardless of the flag', () => {
    const action = validateAction({ tool: 'navigate', url: 'https://example.com/docs', reason: 'go' }, baseOptions);
    assert.equal(action.url, 'https://example.com/docs');
  });

  it('rejects a missing or relative url', () => {
    assert.match(expectError({ tool: 'navigate', reason: 'go' }).hint, /absolute/);
    assert.match(expectError({ tool: 'navigate', url: '/docs', reason: 'go' }).hint, /absolute/);
  });
});

describe('validateAction: key, scroll, wait, ask, finish', () => {
  it('accepts allowed keys case-insensitively and rejects others', () => {
    assert.equal(validateAction({ tool: 'key', key: 'enter', reason: 'r' }, baseOptions).key, 'Enter');
    assert.match(expectError({ tool: 'key', key: 'F12', reason: 'r' }).hint, /Enter/);
    assert.match(expectError({ tool: 'key', reason: 'r' }).hint, /Enter/);
  });

  it('clamps scroll amount and defaults direction to down', () => {
    assert.equal(validateAction({ tool: 'scroll', amount: 99999, reason: 'r' }, baseOptions).amount, 2000);
    assert.equal(validateAction({ tool: 'scroll', amount: -5, reason: 'r' }, baseOptions).amount, 100);
    assert.equal(validateAction({ tool: 'scroll', amount: 'abc', reason: 'r' }, baseOptions).amount, 600);
    assert.equal(validateAction({ tool: 'scroll', reason: 'r' }, baseOptions).direction, 'down');
    assert.equal(validateAction({ tool: 'scroll', direction: 'up', reason: 'r' }, baseOptions).direction, 'up');
  });

  it('clamps wait to a 5 second ceiling', () => {
    assert.equal(validateAction({ tool: 'wait', ms: 60000, reason: 'r' }, baseOptions).ms, 5000);
    assert.equal(validateAction({ tool: 'wait', reason: 'r' }, baseOptions).ms, 800);
  });

  it('requires a question for ask', () => {
    assert.match(expectError({ tool: 'ask', reason: 'r' }).hint, /question/);
    assert.equal(validateAction({ tool: 'ask', question: ' Which plan? ', reason: 'r' }, baseOptions).question, 'Which plan?');
  });

  it('falls back to reason when finish has no answer', () => {
    assert.equal(validateAction({ tool: 'finish', reason: 'All done' }, baseOptions).answer, 'All done');
    assert.equal(validateAction({ tool: 'finish', answer: 'The Pro plan.', reason: 'r' }, baseOptions).answer, 'The Pro plan.');
  });
});

describe('validateAction: injection resistance', () => {
  it('ignores extra keys a model may invent', () => {
    const action = validateAction(
      { tool: 'click', targetId: 'e1', reason: 'go', selector: 'body', script: 'fetch("https://evil.test")', eval: true },
      baseOptions
    );
    assert.deepEqual(Object.keys(action).sort(), ['reason', 'targetId', 'tool']);
  });
});
