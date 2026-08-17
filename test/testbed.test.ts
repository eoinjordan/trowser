/**
 * Verifies the shipped testbed fixture against the real snapshot and policy
 * code.
 *
 * site/testbed.html documents what each section should do. If the fixture and
 * the engine ever disagree, the page becomes actively misleading, so the claims
 * printed on it are asserted here rather than trusted.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assessAction } from '../src/core/policy';
import { detectInjection } from '../src/core/prompt';
import { captureSnapshot } from '../src/page/snapshot';
import type { AgentConfig, PageElement, PageSnapshot } from '../src/types';
import { setupDom, type DomHandle } from './dom';

// Tests are bundled into .tmp/test before running, so a path relative to this
// module would point at the build output. The runner sets cwd to the repo root.
const TESTBED = resolve(process.cwd(), 'site/testbed.html');
const ORIGIN = 'https://trowser.example';

let handle: DomHandle;
let snapshot: PageSnapshot;

/** Trusted origin, so anything still requiring approval does so unconditionally. */
const trustedConfig: AgentConfig = {
  maxSteps: 16,
  approveEverything: false,
  allowCrossOrigin: false,
  trustedOrigins: [ORIGIN],
  textBudget: 6000,
  elementBudget: 90
};

before(() => {
  handle = setupDom(readFileSync(TESTBED, 'utf8'), ORIGIN + '/testbed.html');

  // Put a real secret in the password field so redaction is actually exercised
  // rather than passing because the field happened to be empty.
  const password = handle.dom.window.document.getElementById('pw') as HTMLInputElement | null;
  if (password) password.value = 'sup3rs3cret-value';

  snapshot = captureSnapshot({ textBudget: 6000, elementBudget: 90 });
});

after(() => handle?.cleanup());

function byLabel(needle: string): PageElement {
  const found = snapshot.elements.find(
    (element) => (element.text ?? '').includes(needle) || (element.ariaLabel ?? '').includes(needle)
  );
  assert.ok(found, 'testbed is missing a control labelled "' + needle + '"');
  return found;
}

function byName(name: string): PageElement {
  const found = snapshot.elements.find((element) => element.name === name);
  assert.ok(found, 'testbed is missing a field named "' + name + '"');
  return found;
}

describe('testbed fixture: observation', () => {
  it('exposes every interactive control the page documents', () => {
    for (const label of ['Buy now', 'Place order', 'Delete account', 'Sign out', 'Search']) {
      byLabel(label);
    }
    for (const name of ['q', 'country', 'password', 'reference', 'upload']) {
      byName(name);
    }
  });

  it('never leaks the password value into the observed elements', () => {
    // Scoped to elements: the fixture's own instructional copy legitimately
    // mentions a password, and that is page text, not a captured field value.
    assert.ok(!JSON.stringify(snapshot.elements).includes('sup3rs3cret-value'));
    assert.equal(byName('password').value, '[redacted]');
  });

  it('captures the pricing table text so section 1 is answerable', () => {
    assert.match(snapshot.text, /Business/);
    assert.match(snapshot.text, /Enterprise/);
  });

  it('offers Ireland as a select option for section 3', () => {
    const options = byName('country').options ?? [];
    assert.ok(options.some((option) => option.value === 'IE' && /Ireland/.test(option.label)));
  });
});

describe('testbed fixture: injection detection (section 7)', () => {
  it('flags the planted injection text', () => {
    const findings = detectInjection(snapshot.text);
    assert.ok(findings.length > 0, 'the planted injection was not detected');
    assert.ok(findings.some((finding) => /instruction override|injected instructions/.test(finding.label)));
  });
});

describe('testbed fixture: policy outcomes on a trusted origin', () => {
  it('section 5: destructive controls always require approval', () => {
    for (const label of ['Delete account', 'Sign out']) {
      const decision = assessAction({ tool: 'click', targetId: byLabel(label).id, reason: 'r' }, snapshot, trustedConfig);
      assert.equal(decision.risk, 'destructive', label + ' should be destructive');
      assert.equal(decision.requiresApproval, true, label + ' must ask even on a trusted origin');
    }
  });

  it('section 4: consequential controls are sensitive', () => {
    for (const label of ['Buy now', 'Place order']) {
      assert.equal(
        assessAction({ tool: 'click', targetId: byLabel(label).id, reason: 'r' }, snapshot, trustedConfig).risk,
        'sensitive',
        label + ' should be sensitive'
      );
    }
  });

  it('section 6: credential and payment entry is hard blocked', () => {
    const password = assessAction(
      { tool: 'type', targetId: byName('password').id, text: 'hunter2', reason: 'r' },
      snapshot,
      trustedConfig
    );
    assert.equal(password.risk, 'blocked');

    const card = assessAction(
      { tool: 'type', targetId: byName('reference').id, text: '4111 1111 1111 1111', reason: 'r' },
      snapshot,
      trustedConfig
    );
    assert.equal(card.risk, 'blocked');
    assert.match(card.reason, /payment card/);

    const upload = assessAction(
      { tool: 'type', targetId: byName('upload').id, text: '/etc/passwd', reason: 'r' },
      snapshot,
      trustedConfig
    );
    assert.equal(upload.risk, 'blocked');
  });

  it('sections 2 and 3: routine interactions need no approval', () => {
    const typing = assessAction(
      { tool: 'type', targetId: byName('q').id, text: 'usb-c hub', reason: 'r' },
      snapshot,
      trustedConfig
    );
    assert.equal(typing.risk, 'none');
    assert.equal(typing.requiresApproval, false);

    const selecting = assessAction(
      { tool: 'select', targetId: byName('country').id, value: 'IE', reason: 'r' },
      snapshot,
      trustedConfig
    );
    assert.equal(selecting.risk, 'none');
    assert.equal(selecting.requiresApproval, false);
  });

  it('section 8: the answer is reachable in the page text', () => {
    assert.match(snapshot.text, /trowel/);
  });
});

describe('testbed fixture: policy outcomes on an untrusted origin', () => {
  const untrusted: AgentConfig = { ...trustedConfig, trustedOrigins: [] };

  it('requires approval for consequential controls', () => {
    assert.equal(
      assessAction({ tool: 'click', targetId: byLabel('Buy now').id, reason: 'r' }, snapshot, untrusted).requiresApproval,
      true
    );
  });

  it('still lets routine interactions through', () => {
    assert.equal(
      assessAction({ tool: 'type', targetId: byName('q').id, text: 'x', reason: 'r' }, snapshot, untrusted).requiresApproval,
      false
    );
  });
});
