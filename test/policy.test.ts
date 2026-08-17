import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { assessAction, detectSecret, isTrustedOrigin, luhn } from '../src/core/policy';
import type { AgentAction } from '../src/types';
import { makeAgentConfig, makeElement, makeSnapshot } from './helpers';

function assess(action: AgentAction, elements = makeSnapshot().elements, config = makeAgentConfig()) {
  return assessAction(action, makeSnapshot({ elements }), config);
}

describe('policy: hard blocks', () => {
  it('never types into a password field', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'password' })];
    const decision = assess({ tool: 'type', targetId: 'e1', text: 'hunter2', reason: 'r' }, elements);
    assert.equal(decision.risk, 'blocked');
    assert.equal(decision.requiresApproval, false);
  });

  it('never types into a file field', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'file' })];
    assert.equal(assess({ tool: 'type', targetId: 'e1', text: 'x', reason: 'r' }, elements).risk, 'blocked');
  });

  it('blocks typing a payment card number anywhere', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'text' })];
    const decision = assess({ tool: 'type', targetId: 'e1', text: '4111 1111 1111 1111', reason: 'r' }, elements);
    assert.equal(decision.risk, 'blocked');
    assert.match(decision.reason, /payment card/);
  });

  it('blocks typing an API key', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'text' })];
    const decision = assess({ tool: 'type', targetId: 'e1', text: 'ghp_' + 'a'.repeat(36), reason: 'r' }, elements);
    assert.equal(decision.risk, 'blocked');
  });

  it('blocks interacting with a disabled element', () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Next', disabled: true })];
    assert.equal(assess({ tool: 'click', targetId: 'e1', reason: 'r' }, elements).risk, 'blocked');
  });

  it('blocks a non-http navigation scheme even if schema validation were skipped', () => {
    assert.equal(assess({ tool: 'navigate', url: 'javascript:alert(1)', reason: 'r' }).risk, 'blocked');
  });
});

describe('policy: destructive actions', () => {
  const destructiveLabels = ['Delete account', 'Remove all items', 'Cancel subscription', 'Sign out', 'Revoke access', 'Deactivate'];

  for (const text of destructiveLabels) {
    it('flags "' + text + '" as destructive and always requires approval', () => {
      const elements = [makeElement({ id: 'e1', tag: 'button', text })];
      const decision = assess({ tool: 'click', targetId: 'e1', reason: 'r' }, elements);
      assert.equal(decision.risk, 'destructive');
      assert.equal(decision.requiresApproval, true);
    });
  }

  it('still requires approval for destructive actions on a trusted origin', () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Delete account' })];
    const config = makeAgentConfig({ trustedOrigins: ['https://example.com'] });
    const decision = assessAction({ tool: 'click', targetId: 'e1', reason: 'r' }, makeSnapshot({ elements }), config);
    assert.equal(decision.requiresApproval, true);
  });
});

describe('policy: sensitive actions', () => {
  const sensitiveLabels = ['Buy now', 'Place order', 'Checkout', 'Send message', 'Submit', 'Publish', 'Book', 'Apply', 'Donate'];

  for (const text of sensitiveLabels) {
    it('flags "' + text + '" as sensitive', () => {
      const elements = [makeElement({ id: 'e1', tag: 'button', text })];
      assert.equal(assess({ tool: 'click', targetId: 'e1', reason: 'r' }, elements).risk, 'sensitive');
    });
  }

  it('treats a form submit button as sensitive even with a neutral label', () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', type: 'submit', text: 'Go', inForm: true })];
    const decision = assess({ tool: 'click', targetId: 'e1', reason: 'r' }, elements);
    assert.equal(decision.risk, 'sensitive');
  });

  it('treats Enter as sensitive because it can submit a form', () => {
    assert.equal(assess({ tool: 'key', key: 'Enter', reason: 'r' }).risk, 'sensitive');
  });

  it('treats type-and-submit as sensitive', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'text' })];
    assert.equal(assess({ tool: 'type', targetId: 'e1', text: 'x', submit: true, reason: 'r' }, elements).risk, 'sensitive');
  });

  it('treats entering an email address as sensitive', () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'email' })];
    assert.equal(assess({ tool: 'type', targetId: 'e1', text: 'a@b.com', reason: 'r' }, elements).risk, 'sensitive');
  });

  it('auto-approves sensitive actions on a trusted origin', () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Submit' })];
    const config = makeAgentConfig({ trustedOrigins: ['https://example.com'] });
    const decision = assessAction({ tool: 'click', targetId: 'e1', reason: 'r' }, makeSnapshot({ elements }), config);
    assert.equal(decision.risk, 'sensitive');
    assert.equal(decision.requiresApproval, false);
  });

  it('flags cross-origin navigation as sensitive', () => {
    const config = makeAgentConfig({ allowCrossOrigin: true });
    const decision = assessAction({ tool: 'navigate', url: 'https://other.test/', reason: 'r' }, makeSnapshot(), config);
    assert.equal(decision.risk, 'sensitive');
  });
});

describe('policy: routine actions', () => {
  it('treats reading, scrolling, waiting, asking and finishing as free', () => {
    for (const tool of ['read', 'scroll', 'wait', 'ask', 'finish'] as const) {
      const decision = assess({ tool, reason: 'r' });
      assert.equal(decision.risk, 'none');
      assert.equal(decision.requiresApproval, false);
    }
  });

  it('treats clicking an ordinary link as routine', () => {
    const elements = [makeElement({ id: 'e1', tag: 'a', text: 'Pricing' })];
    const decision = assess({ tool: 'click', targetId: 'e1', reason: 'r' }, elements);
    assert.equal(decision.risk, 'none');
    assert.equal(decision.requiresApproval, false);
  });

  it('treats same-origin navigation as routine', () => {
    assert.equal(assess({ tool: 'navigate', url: 'https://example.com/pricing', reason: 'r' }).risk, 'none');
  });

  it('requires approval for everything when the user opts in', () => {
    const elements = [makeElement({ id: 'e1', tag: 'a', text: 'Pricing' })];
    const config = makeAgentConfig({ approveEverything: true });
    const decision = assessAction({ tool: 'click', targetId: 'e1', reason: 'r' }, makeSnapshot({ elements }), config);
    assert.equal(decision.risk, 'none');
    assert.equal(decision.requiresApproval, true);
  });

  it('does not force approval for read-only tools even when approveEverything is set', () => {
    const config = makeAgentConfig({ approveEverything: true });
    assert.equal(assessAction({ tool: 'read', reason: 'r' }, makeSnapshot(), config).requiresApproval, false);
  });
});

describe('detectSecret', () => {
  it('detects valid card numbers', () => {
    assert.match(String(detectSecret('4111111111111111')), /payment card/);
    assert.match(String(detectSecret('5500 0000 0000 0004')), /payment card/);
  });

  it('ignores long numbers that fail the Luhn check', () => {
    assert.equal(detectSecret('1234567890123456'), null);
  });

  it('ignores ordinary text and short numbers', () => {
    assert.equal(detectSecret('Trowser local agent test'), null);
    assert.equal(detectSecret('2024'), null);
    assert.equal(detectSecret(''), null);
  });

  it('detects tokens from common providers', () => {
    assert.match(String(detectSecret('sk-' + 'a'.repeat(32))), /API key/);
    assert.match(String(detectSecret('hf_' + 'b'.repeat(30))), /API key/);
    assert.match(String(detectSecret('AKIAIOSFODNN7EXAMPLE')), /API key/);
  });

  it('detects private keys and national identifiers', () => {
    assert.match(String(detectSecret('-----BEGIN RSA PRIVATE KEY-----')), /private key/);
    assert.match(String(detectSecret('078-05-1120')), /social security/);
  });

  it('luhn rejects non-numeric input', () => {
    assert.equal(luhn('41111111111111a1'), false);
  });
});

describe('isTrustedOrigin', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    assert.equal(isTrustedOrigin('https://example.com', [' HTTPS://EXAMPLE.COM ']), true);
  });

  it('does not match a different origin or a path prefix', () => {
    assert.equal(isTrustedOrigin('https://evil.com', ['https://example.com']), false);
    assert.equal(isTrustedOrigin('https://example.com.evil.com', ['https://example.com']), false);
  });

  it('returns false for an empty origin', () => {
    assert.equal(isTrustedOrigin('', ['https://example.com']), false);
  });
});
