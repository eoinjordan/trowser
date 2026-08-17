import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { countTrailing, describeAction, runAgent, signatureOf, type AgentLoopOptions } from '../src/agent/loop';
import { JsonExtractionError } from '../src/core/jsonrepair';
import type { AgentAction, AgentEvent, DecideInput, LlmProvider, PageSnapshot, ToolResult } from '../src/types';
import type { BrowserTools } from '../src/tools/browser';
import { makeAgentConfig, makeElement, makeSnapshot } from './helpers';

/** A provider that replays a scripted list of raw model outputs. */
class ScriptedProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly name = 'Scripted';
  readonly locality = 'test';
  readonly seen: DecideInput[] = [];

  private index = 0;

  constructor(private readonly script: Array<unknown | (() => unknown)>) {}

  async initialize(): Promise<void> {}

  async decide(input: DecideInput): Promise<unknown> {
    this.seen.push(input);
    const entry = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (typeof entry === 'function') return (entry as () => unknown)();
    return entry;
  }

  async dispose(): Promise<void> {}
}

class FakeTools implements BrowserTools {
  readonly executed: AgentAction[] = [];

  constructor(
    private readonly snapshotValue: PageSnapshot = makeSnapshot(),
    private readonly resultFor: (action: AgentAction) => ToolResult = () => ({ ok: true, message: 'done', changed: true })
  ) {}

  async snapshot(): Promise<PageSnapshot> {
    return this.snapshotValue;
  }

  async execute(action: AgentAction): Promise<ToolResult> {
    this.executed.push(action);
    return this.resultFor(action);
  }
}

function run(overrides: Partial<AgentLoopOptions> & { provider: LlmProvider; tools: BrowserTools }) {
  const events: AgentEvent[] = [];
  const options: AgentLoopOptions = {
    goal: 'Find the SSO plan',
    config: makeAgentConfig(),
    sleep: async () => {},
    onEvent: (event) => events.push(event),
    approve: async () => true,
    ...overrides
  };
  return { events, outcome: runAgent(options) };
}

describe('runAgent: happy path', () => {
  it('returns the answer when the model finishes', async () => {
    const provider = new ScriptedProvider([{ tool: 'finish', answer: 'The Enterprise plan.', reason: 'found it' }]);
    const { outcome } = run({ provider, tools: new FakeTools() });
    const result = await outcome;

    assert.equal(result.status, 'done');
    assert.equal(result.answer, 'The Enterprise plan.');
    assert.equal(result.steps, 1);
  });

  it('executes a sequence of actions then finishes', async () => {
    const tools = new FakeTools();
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'open pricing' },
      { tool: 'scroll', direction: 'down', reason: 'look for SSO' },
      { tool: 'finish', answer: 'Enterprise includes SSO.', reason: 'done' }
    ]);

    const result = await run({ provider, tools }).outcome;

    assert.equal(result.status, 'done');
    assert.deepEqual(tools.executed.map((action) => action.tool), ['click', 'scroll']);
    assert.equal(result.history.length, 2);
  });

  it('emits action and result events in order', async () => {
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'open' },
      { tool: 'finish', answer: 'ok', reason: 'done' }
    ]);
    const { events, outcome } = run({ provider, tools: new FakeTools() });
    await outcome;

    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.indexOf('action') < kinds.indexOf('result'));
    assert.equal(events.at(-1)?.kind, 'done');
  });

  it('passes accumulated history to the provider', async () => {
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'open' },
      { tool: 'finish', answer: 'ok', reason: 'done' }
    ]);
    await run({ provider, tools: new FakeTools() }).outcome;

    assert.equal(provider.seen[0].history.length, 0);
    assert.equal(provider.seen[1].history.length, 1);
    assert.equal(provider.seen[1].history[0].action.tool, 'click');
  });
});

describe('runAgent: decode retries', () => {
  it('retries with a hint when the provider cannot extract JSON', async () => {
    // Providers own extraction, so an unparseable model reply surfaces here as
    // a JsonExtractionError thrown out of decide().
    const provider = new ScriptedProvider([
      () => {
        throw new JsonExtractionError('No JSON object found in model output.', 'I cannot help with that.');
      },
      { tool: 'finish', answer: 'recovered', reason: 'done' }
    ]);
    const { events, outcome } = run({ provider, tools: new FakeTools() });
    const result = await outcome;

    assert.equal(result.status, 'done');
    assert.equal(result.answer, 'recovered');
    assert.ok(events.some((event) => event.kind === 'warning'));
    assert.ok(provider.seen[1].hints?.some((hint) => /valid JSON/i.test(hint)));
  });

  it('retries with a hint when the model returns a non-object', async () => {
    const provider = new ScriptedProvider(['I cannot help with that.', { tool: 'finish', answer: 'recovered', reason: 'done' }]);
    const result = await run({ provider, tools: new FakeTools() }).outcome;

    assert.equal(result.status, 'done');
    assert.ok(provider.seen[1].hints?.some((hint) => /single JSON object/i.test(hint)));
  });

  it('retries with a grounding hint after a hallucinated element id', async () => {
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e999', reason: 'guess' },
      { tool: 'finish', answer: 'recovered', reason: 'done' }
    ]);
    const result = await run({ provider, tools: new FakeTools() }).outcome;

    assert.equal(result.status, 'done');
    assert.ok(provider.seen[1].hints?.some((hint) => hint.includes('e999')));
  });

  it('gives up after three failed decode attempts', async () => {
    const provider = new ScriptedProvider(['not json', 'still not json', 'nope', 'nope']);
    const result = await run({ provider, tools: new FakeTools() }).outcome;

    assert.equal(result.status, 'stalled');
    assert.match(result.answer, /could not produce a valid action/);
  });

  it('does not retry a backend failure', async () => {
    let calls = 0;
    const provider = new ScriptedProvider([
      () => {
        calls += 1;
        throw new Error('Could not reach Ollama at http://127.0.0.1:11434.');
      }
    ]);

    await assert.rejects(() => run({ provider, tools: new FakeTools() }).outcome, /Could not reach Ollama/);
    assert.equal(calls, 1);
  });
});

describe('runAgent: policy enforcement', () => {
  it('does not execute a blocked action', async () => {
    const elements = [makeElement({ id: 'e1', tag: 'input', type: 'password' })];
    const tools = new FakeTools(makeSnapshot({ elements }));
    const provider = new ScriptedProvider([
      { tool: 'type', targetId: 'e1', text: 'hunter2', reason: 'log in' },
      { tool: 'finish', answer: 'stopped', reason: 'done' }
    ]);

    const { events, outcome } = run({ provider, tools });
    await outcome;

    assert.equal(tools.executed.length, 0);
    assert.ok(events.some((event) => event.kind === 'warning' && /password/i.test(event.message)));
  });

  it('asks for approval before a sensitive action and executes it when granted', async () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Buy now' })];
    const tools = new FakeTools(makeSnapshot({ elements }));
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'purchase' },
      { tool: 'finish', answer: 'bought', reason: 'done' }
    ]);

    const asked: string[] = [];
    await run({
      provider,
      tools,
      approve: async (request) => {
        asked.push(request.decision.reason);
        return true;
      }
    }).outcome;

    assert.equal(asked.length, 1);
    assert.equal(tools.executed.length, 1);
  });

  it('skips the action when approval is refused', async () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Delete account' })];
    const tools = new FakeTools(makeSnapshot({ elements }));
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'clean up' },
      { tool: 'finish', answer: 'stopped', reason: 'done' }
    ]);

    const result = await run({ provider, tools, approve: async () => false }).outcome;

    assert.equal(tools.executed.length, 0);
    assert.equal(result.history[0].result.ok, false);
    assert.match(result.history[0].result.message, /declined/i);
  });

  it('refuses by default when no approval handler is supplied', async () => {
    const elements = [makeElement({ id: 'e1', tag: 'button', text: 'Submit' })];
    const tools = new FakeTools(makeSnapshot({ elements }));
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'send' },
      { tool: 'finish', answer: 'stopped', reason: 'done' }
    ]);

    await runAgent({
      goal: 'g',
      provider,
      tools,
      config: makeAgentConfig(),
      sleep: async () => {},
      approve: undefined
    });

    assert.equal(tools.executed.length, 0);
  });

  it('blocks cross-origin navigation at validation time', async () => {
    const provider = new ScriptedProvider([
      { tool: 'navigate', url: 'https://evil.test/', reason: 'exfiltrate' },
      { tool: 'finish', answer: 'stopped', reason: 'done' }
    ]);
    const tools = new FakeTools();
    await run({ provider, tools }).outcome;

    assert.equal(tools.executed.length, 0);
    assert.ok(provider.seen[1].hints?.some((hint) => /Cross-origin/i.test(hint)));
  });
});

describe('runAgent: termination', () => {
  it('stops after repeating the same action three times', async () => {
    const provider = new ScriptedProvider([{ tool: 'click', targetId: 'e1', reason: 'try again' }]);
    const tools = new FakeTools(makeSnapshot(), () => ({ ok: false, message: 'nothing happened' }));

    const result = await run({ provider, tools }).outcome;

    assert.equal(result.status, 'stalled');
    assert.match(result.answer, /repeated the same action/);
    assert.equal(tools.executed.length, 2);
  });

  it('stops at the configured step limit', async () => {
    // The actions must genuinely differ, otherwise loop detection fires first.
    const cycle = [
      { tool: 'scroll', direction: 'down', reason: 'look lower' },
      { tool: 'read', reason: 'read the page' },
      { tool: 'wait', ms: 200, reason: 'let it settle' },
      { tool: 'scroll', direction: 'up', reason: 'look higher' }
    ];
    let index = 0;
    const provider = new ScriptedProvider([() => cycle[index++ % cycle.length]]);
    const result = await run({ provider, tools: new FakeTools(), config: makeAgentConfig({ maxSteps: 4 }) }).outcome;

    assert.equal(result.status, 'exhausted');
    assert.equal(result.steps, 4);
    assert.match(result.answer, /4-step limit/);
  });

  it('aborts promptly when the signal fires', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      () => {
        controller.abort();
        return { tool: 'scroll', direction: 'down', reason: 'r' };
      }
    ]);

    await assert.rejects(
      () => run({ provider, tools: new FakeTools(), signal: controller.signal }).outcome,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    );
  });

  it('records a tool failure and keeps going', async () => {
    const provider = new ScriptedProvider([
      { tool: 'click', targetId: 'e1', reason: 'try' },
      { tool: 'finish', answer: 'moved on', reason: 'done' }
    ]);
    const tools = new FakeTools(makeSnapshot(), () => {
      throw new Error('Element detached');
    });

    const result = await run({ provider, tools }).outcome;

    assert.equal(result.status, 'done');
    assert.equal(result.history[0].result.ok, false);
    assert.match(result.history[0].result.message, /Element detached/);
  });
});

describe('runAgent: ask', () => {
  it('feeds the user answer back into history', async () => {
    const provider = new ScriptedProvider([
      { tool: 'ask', question: 'Which plan?', reason: 'ambiguous' },
      { tool: 'finish', answer: 'Enterprise', reason: 'done' }
    ]);

    const result = await run({ provider, tools: new FakeTools(), answerQuestion: async () => 'Enterprise' }).outcome;

    assert.equal(result.status, 'done');
    assert.match(result.history[0].result.message, /User answered: Enterprise/);
  });

  it('stops when the question goes unanswered', async () => {
    const provider = new ScriptedProvider([{ tool: 'ask', question: 'Which plan?', reason: 'ambiguous' }]);
    const result = await run({ provider, tools: new FakeTools(), answerQuestion: async () => undefined }).outcome;

    assert.equal(result.status, 'stopped');
  });
});

describe('loop helpers', () => {
  it('signatureOf distinguishes different targets and matches identical actions', () => {
    const base: AgentAction = { tool: 'click', targetId: 'e1', reason: 'a' };
    assert.equal(signatureOf(base), signatureOf({ ...base, reason: 'different reason' }));
    assert.notEqual(signatureOf(base), signatureOf({ ...base, targetId: 'e2' }));
  });

  it('signatureOf ignores scroll amount on purpose', () => {
    // Scrolling repeatedly by a slightly different amount is still a stuck
    // loop, so amount must not make the signature look novel.
    const down: AgentAction = { tool: 'scroll', direction: 'down', amount: 300, reason: 'r' };
    assert.equal(signatureOf(down), signatureOf({ ...down, amount: 900 }));
    assert.notEqual(signatureOf(down), signatureOf({ ...down, direction: 'up' }));
  });

  it('countTrailing counts only the run at the end', () => {
    assert.equal(countTrailing(['a', 'b', 'b', 'b'], 'b'), 3);
    assert.equal(countTrailing(['b', 'b', 'a'], 'b'), 0);
    assert.equal(countTrailing([], 'b'), 0);
  });

  it('describeAction summarises the action for the trace', () => {
    assert.match(describeAction({ tool: 'click', targetId: 'e1', reason: 'open pricing' }), /click e1 - open pricing/);
    assert.match(describeAction({ tool: 'type', targetId: 'e2', text: 'hello', reason: 'search' }), /"hello"/);
  });
});
