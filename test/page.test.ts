import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { setupDom, type DomHandle } from './dom';
import { captureSnapshot, accessibleName, extractText, isVisible, rank } from '../src/page/snapshot';
import { executeAction, resolveTarget } from '../src/page/actions';
import type { AgentAction } from '../src/types';

let handle: DomHandle | undefined;

function mount(html: string, url?: string): void {
  handle?.cleanup();
  handle = setupDom(html, url);
}

afterEach(() => {
  handle?.cleanup();
  handle = undefined;
});

const noSleep = async () => {};

function act(action: Partial<AgentAction> & { tool: AgentAction['tool'] }) {
  return executeAction({ reason: 'test', ...action } as AgentAction, noSleep);
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

describe('captureSnapshot: element collection', () => {
  it('finds links, buttons, inputs, selects and textareas', () => {
    mount(`
      <a href="/pricing">Pricing</a>
      <button>Sign in</button>
      <input type="text" name="q" placeholder="Search" />
      <select name="country"><option value="IE">Ireland</option></select>
      <textarea name="notes"></textarea>
    `);

    const tags = captureSnapshot().elements.map((element) => element.tag).sort();
    assert.deepEqual(tags, ['a', 'button', 'input', 'select', 'textarea']);
  });

  it('assigns sequential grounded ids and tags the DOM with them', () => {
    mount('<button>One</button><button>Two</button>');
    const snapshot = captureSnapshot();

    assert.deepEqual(snapshot.elements.map((element) => element.id), ['e1', 'e2']);
    assert.equal(document.querySelectorAll('[data-trowser-id]').length, 2);
  });

  it('skips hidden, zero-sized and aria-hidden elements', () => {
    mount(`
      <button>Visible</button>
      <button data-test-hidden>Zero size</button>
      <button style="display:none">Display none</button>
      <button style="visibility:hidden">Invisible</button>
      <button aria-hidden="true">Aria hidden</button>
      <button inert>Inert</button>
    `);

    const texts = captureSnapshot().elements.map((element) => element.text);
    assert.deepEqual(texts, ['Visible']);
  });

  it('excludes hidden inputs but includes other input types', () => {
    mount('<input type="hidden" name="csrf" /><input type="checkbox" name="agree" />');
    const snapshot = captureSnapshot();

    assert.equal(snapshot.elements.length, 1);
    assert.equal(snapshot.elements[0].type, 'checkbox');
  });

  it('clears stale ids so an old id cannot resolve to a new element', () => {
    mount('<button id="a">A</button><button id="b">B</button>');
    captureSnapshot();

    // Drop the first button and re-snapshot; e1 must now be the survivor only.
    document.getElementById('a')?.remove();
    const second = captureSnapshot();

    assert.equal(second.elements.length, 1);
    assert.equal(document.querySelectorAll('[data-trowser-id]').length, 1);
    assert.equal(document.getElementById('b')?.dataset.trowserId, 'e1');
  });

  it('traverses open shadow roots but not closed ones', () => {
    mount('<div id="open"></div><div id="closed"></div>');

    const open = document.getElementById('open') as HTMLElement;
    open.attachShadow({ mode: 'open' }).innerHTML = '<button>Inside open</button>';

    const closed = document.getElementById('closed') as HTMLElement;
    closed.attachShadow({ mode: 'closed' }).innerHTML = '<button>Inside closed</button>';

    const texts = captureSnapshot().elements.map((element) => element.text);
    assert.deepEqual(texts, ['Inside open']);
  });

  it('respects the element budget and reports the true total', () => {
    mount(Array.from({ length: 40 }, (_, index) => `<button>B${index}</button>`).join(''));
    const snapshot = captureSnapshot({ elementBudget: 10 });

    assert.equal(snapshot.elements.length, 10);
    assert.equal(snapshot.totalElements, 40);
  });

  it('reports scroll position and origin', () => {
    mount('<button>x</button>', 'https://shop.example.com/cart?id=3');
    const snapshot = captureSnapshot();

    assert.equal(snapshot.origin, 'https://shop.example.com');
    assert.equal(snapshot.url, 'https://shop.example.com/cart?id=3');
    assert.equal(snapshot.scroll.viewport, 800);
    assert.equal(snapshot.scroll.height, 4000);
  });
});

describe('captureSnapshot: element description', () => {
  it('never exposes a password value', () => {
    mount('<input type="password" name="pw" value="hunter2" />');
    const element = captureSnapshot().elements[0];

    assert.equal(element.value, '[redacted]');
    assert.ok(!JSON.stringify(element).includes('hunter2'));
  });

  it('reports the value of ordinary fields', () => {
    mount('<input type="text" name="q" value="laptops" />');
    assert.equal(captureSnapshot().elements[0].value, 'laptops');
  });

  it('captures disabled, required and checked state', () => {
    mount(`
      <button disabled>Off</button>
      <input type="text" required name="a" />
      <input type="checkbox" checked name="b" />
    `);

    const byName = new Map(captureSnapshot().elements.map((element) => [element.text || element.name, element]));
    assert.equal(byName.get('Off')?.disabled, true);
    assert.equal(byName.get('a')?.required, true);
    assert.equal(byName.get('b')?.checked, true);
  });

  it('lists select options', () => {
    mount('<select name="c"><option value="IE">Ireland</option><option value="FR">France</option></select>');
    assert.deepEqual(captureSnapshot().elements[0].options, [
      { value: 'IE', label: 'Ireland' },
      { value: 'FR', label: 'France' }
    ]);
  });

  it('marks elements inside a form', () => {
    mount('<form><button>In</button></form><button>Out</button>');
    const byText = new Map(captureSnapshot().elements.map((element) => [element.text, element]));

    assert.equal(byText.get('In')?.inForm, true);
    assert.equal(byText.get('Out')?.inForm ?? false, false);
  });

  it('marks offscreen elements', () => {
    mount('<button data-test-rect="5,10,100,30">Near</button><button data-test-rect="3000,10,100,30">Far</button>');
    const byText = new Map(captureSnapshot().elements.map((element) => [element.text, element]));

    assert.equal(byText.get('Near')?.inView, true);
    assert.equal(byText.get('Far')?.inView, false);
  });
});

describe('accessibleName', () => {
  it('prefers aria-label', () => {
    mount('<button aria-label="Close dialog">x</button>');
    assert.equal(accessibleName(document.querySelector('button') as HTMLElement), 'Close dialog');
  });

  it('resolves aria-labelledby', () => {
    mount('<span id="lbl">Delete account</span><button aria-labelledby="lbl">x</button>');
    assert.equal(accessibleName(document.querySelector('button') as HTMLElement), 'Delete account');
  });

  it('uses an associated label element', () => {
    mount('<label for="email">Email address</label><input id="email" type="email" />');
    assert.equal(accessibleName(document.querySelector('input') as HTMLElement), 'Email address');
  });

  it('falls back to title and nested image alt', () => {
    mount('<button title="Settings">x</button><button id="i"><img alt="Search" /></button>');
    assert.equal(accessibleName(document.querySelector('button') as HTMLElement), 'Settings');
    assert.equal(accessibleName(document.getElementById('i') as HTMLElement), 'Search');
  });

  it('returns undefined when there is no name', () => {
    mount('<button></button>');
    assert.equal(accessibleName(document.querySelector('button') as HTMLElement), undefined);
  });
});

describe('extractText', () => {
  it('prefers the main landmark over navigation chrome', () => {
    mount('<nav>Home About Contact</nav><main>The Enterprise plan includes SSO.</main>');
    const { text } = extractText(5000);

    assert.match(text, /Enterprise plan includes SSO/);
    assert.ok(!text.includes('About'));
  });

  it('skips script and style content', () => {
    mount('<main>Real text<script>var secret = 1;</script><style>.a{color:red}</style></main>');
    const { text } = extractText(5000);

    assert.match(text, /Real text/);
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('color:red'));
  });

  it('reports truncation when over budget', () => {
    mount('<main>' + 'word '.repeat(2000) + '</main>');
    const { text, truncated } = extractText(100);

    assert.equal(truncated, true);
    assert.equal(text.length, 100);
  });

  it('does not report truncation when under budget', () => {
    mount('<main>short</main>');
    assert.equal(extractText(5000).truncated, false);
  });
});

describe('rank', () => {
  it('scores on-screen elements above offscreen ones', () => {
    mount('<button data-test-rect="5,10,100,30">A</button>');
    const button = document.querySelector('button') as HTMLElement;

    assert.ok(rank(button, true) > rank(button, false));
  });

  it('penalises disabled elements', () => {
    mount('<button>A</button><button disabled>B</button>');
    const [enabled, disabled] = Array.from(document.querySelectorAll('button')) as HTMLElement[];

    assert.ok(rank(enabled, true) > rank(disabled, true));
  });
});

describe('isVisible', () => {
  it('rejects zero-sized and styled-hidden elements', () => {
    mount('<button data-test-hidden>a</button><button style="display:none">b</button><button>c</button>');
    const [zero, hidden, shown] = Array.from(document.querySelectorAll('button'));

    assert.equal(isVisible(zero), false);
    assert.equal(isVisible(hidden), false);
    assert.equal(isVisible(shown), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

describe('executeAction: click', () => {
  it('clicks a grounded element', async () => {
    mount('<button>Go</button>');
    captureSnapshot();

    let clicked = false;
    (document.querySelector('button') as HTMLElement).addEventListener('click', () => {
      clicked = true;
    });

    const result = await act({ tool: 'click', targetId: 'e1' });

    assert.equal(result.ok, true);
    assert.equal(clicked, true);
    assert.equal(result.changed, true);
  });

  it('dispatches the full pointer sequence frameworks expect', async () => {
    mount('<button>Go</button>');
    captureSnapshot();

    const seen: string[] = [];
    const button = document.querySelector('button') as HTMLElement;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type));
    }

    await act({ tool: 'click', targetId: 'e1' });
    assert.deepEqual(seen, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('fails cleanly when the element has gone', async () => {
    mount('<button>Go</button>');
    captureSnapshot();
    document.querySelector('button')?.remove();

    const result = await act({ tool: 'click', targetId: 'e1' });

    assert.equal(result.ok, false);
    assert.match(result.message, /no longer on the page/);
  });

  it('refuses an id that was never issued', async () => {
    mount('<button>Go</button>');
    captureSnapshot();

    const result = await act({ tool: 'click', targetId: 'e99' });
    assert.equal(result.ok, false);
  });
});

describe('executeAction: type', () => {
  it('types into a text input and fires input and change', async () => {
    mount('<input type="text" name="q" />');
    captureSnapshot();

    const events: string[] = [];
    const input = document.querySelector('input') as HTMLInputElement;
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));

    const result = await act({ tool: 'type', targetId: 'e1', text: 'laptops' });

    assert.equal(result.ok, true);
    assert.equal(input.value, 'laptops');
    assert.deepEqual(events, ['input', 'change']);
  });

  it('types into a textarea', async () => {
    mount('<textarea name="n"></textarea>');
    captureSnapshot();

    await act({ tool: 'type', targetId: 'e1', text: 'hello' });
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, 'hello');
  });

  it('blocks password fields even if the policy layer were bypassed', async () => {
    mount('<input type="password" name="pw" />');
    captureSnapshot();

    const result = await act({ tool: 'type', targetId: 'e1', text: 'hunter2' });

    assert.equal(result.ok, false);
    assert.equal(result.risk, 'blocked');
    assert.equal((document.querySelector('input') as HTMLInputElement).value, '');
  });

  it('blocks file inputs', async () => {
    mount('<input type="file" name="f" />');
    captureSnapshot();

    const result = await act({ tool: 'type', targetId: 'e1', text: '/etc/passwd' });
    assert.equal(result.ok, false);
    assert.equal(result.risk, 'blocked');
  });

  it('refuses a non-text element', async () => {
    mount('<button>Go</button>');
    captureSnapshot();

    const result = await act({ tool: 'type', targetId: 'e1', text: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.message, /not a text field/);
  });

  it('submits the form when submit is set', async () => {
    mount('<form><input type="text" name="q" /></form>');
    captureSnapshot();

    let submitted = false;
    (document.querySelector('form') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    const result = await act({ tool: 'type', targetId: 'e1', text: 'q', submit: true });

    assert.equal(result.ok, true);
    assert.equal(submitted, true);
  });
});

describe('executeAction: select', () => {
  it('selects by option value', async () => {
    mount('<select name="c"><option value="IE">Ireland</option><option value="FR">France</option></select>');
    captureSnapshot();

    const result = await act({ tool: 'select', targetId: 'e1', value: 'FR' });

    assert.equal(result.ok, true);
    assert.equal((document.querySelector('select') as HTMLSelectElement).value, 'FR');
  });

  it('falls back to matching the visible label', async () => {
    mount('<select name="c"><option value="IE">Ireland</option><option value="FR">France</option></select>');
    captureSnapshot();

    const result = await act({ tool: 'select', targetId: 'e1', value: 'france' });

    assert.equal(result.ok, true);
    assert.equal((document.querySelector('select') as HTMLSelectElement).value, 'FR');
  });

  it('lists the available options when the value is unknown', async () => {
    mount('<select name="c"><option value="IE">Ireland</option></select>');
    captureSnapshot();

    const result = await act({ tool: 'select', targetId: 'e1', value: 'ZZ' });

    assert.equal(result.ok, false);
    assert.match(result.message, /Available: IE/);
  });

  it('refuses a non-select element', async () => {
    mount('<button>Go</button>');
    captureSnapshot();

    const result = await act({ tool: 'select', targetId: 'e1', value: 'x' });
    assert.equal(result.ok, false);
  });
});

describe('executeAction: navigation-free tools', () => {
  it('scroll reports how far it actually moved', async () => {
    mount('<main>text</main>');
    const result = await act({ tool: 'scroll', direction: 'down', amount: 600 });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.match(result.message, /Scrolled down 600px/);
  });

  it('scroll reports reaching the top rather than pretending to move', async () => {
    mount('<main>text</main>');
    const result = await act({ tool: 'scroll', direction: 'up', amount: 600 });

    assert.equal(result.changed, false);
    assert.match(result.message, /Already at the top/);
  });

  it('read returns page text as data', async () => {
    mount('<main>The Enterprise plan includes SSO.</main>');
    const result = await act({ tool: 'read' });

    assert.equal(result.ok, true);
    assert.match(String(result.data), /Enterprise plan includes SSO/);
  });

  it('wait and finish and ask succeed without touching the page', async () => {
    mount('<main>x</main>');

    assert.equal((await act({ tool: 'wait', ms: 10 })).ok, true);
    assert.equal((await act({ tool: 'finish', answer: 'done' })).message, 'done');
    assert.equal((await act({ tool: 'ask', question: 'which?' })).message, 'which?');
  });
});

describe('resolveTarget', () => {
  it('finds an element inside an open shadow root', () => {
    mount('<div id="host"></div>');
    const host = document.getElementById('host') as HTMLElement;
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button>';

    captureSnapshot();
    const found = resolveTarget({ tool: 'click', targetId: 'e1', reason: 'r' });

    assert.ok(found);
    assert.equal(found?.tagName, 'BUTTON');
  });

  it('returns null for a missing id', () => {
    mount('<button>x</button>');
    captureSnapshot();

    assert.equal(resolveTarget({ tool: 'click', targetId: 'nope', reason: 'r' }), null);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end                                                                  */
/* -------------------------------------------------------------------------- */

describe('snapshot to action round trip', () => {
  it('every id in a snapshot resolves back to its element', async () => {
    mount(`
      <main>
        <form>
          <label for="q">Search</label>
          <input id="q" type="text" name="q" />
          <select name="c"><option value="IE">Ireland</option></select>
          <button type="submit">Go</button>
        </form>
        <a href="/pricing">Pricing</a>
      </main>
    `);

    const snapshot = captureSnapshot();
    assert.equal(snapshot.elements.length, 4);

    for (const element of snapshot.elements) {
      const resolved = resolveTarget({ tool: 'click', targetId: element.id, reason: 'r' });
      assert.ok(resolved, 'id ' + element.id + ' (' + element.tag + ') did not resolve');
      assert.equal(resolved?.tagName.toLowerCase(), element.tag);
    }
  });

  it('a realistic search flow types then submits', async () => {
    mount(`
      <main>
        <form id="search">
          <input type="text" name="q" placeholder="Search products" />
          <button type="submit">Search</button>
        </form>
      </main>
    `);

    const snapshot = captureSnapshot();
    const field = snapshot.elements.find((element) => element.tag === 'input');
    assert.ok(field, 'expected the search field in the snapshot');

    let submitted = false;
    (document.getElementById('search') as HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    const typed = await act({ tool: 'type', targetId: field.id, text: 'usb-c hub' });
    assert.equal(typed.ok, true);

    const button = snapshot.elements.find((element) => element.tag === 'button');
    assert.ok(button);
    await act({ tool: 'click', targetId: button.id });

    assert.equal(submitted, true);
    assert.equal((document.querySelector('input') as HTMLInputElement).value, 'usb-c hub');
  });
});
