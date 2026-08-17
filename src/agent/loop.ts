/**
 * The agent loop.
 *
 * observe -> decide -> validate -> assess -> approve -> act -> verify
 *
 * Everything it touches is injected (tools, provider, clock, approval), so the
 * whole control flow including retries, loop detection and the policy gate is
 * exercised by unit tests with no browser and no model.
 */

import type { AgentAction, AgentConfig, AgentEvent, HistoryEntry, LlmProvider, PageSnapshot, ToolResult } from '../types';
import { JsonExtractionError } from '../core/jsonrepair';
import { assessAction, type PolicyDecision } from '../core/policy';
import { ActionValidationError, validateAction } from '../core/schema';
import type { BrowserTools } from '../tools/browser';

export interface ApprovalRequest {
  action: AgentAction;
  decision: PolicyDecision;
  snapshot: PageSnapshot;
}

export interface AgentLoopOptions {
  goal: string;
  provider: LlmProvider;
  tools: BrowserTools;
  config: AgentConfig;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Returns true to allow a risky action. Defaults to refusing. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  /** Answers an `ask` action. Returning undefined ends the run. */
  answerQuestion?: (question: string) => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentOutcome {
  answer: string;
  status: 'done' | 'exhausted' | 'stalled' | 'stopped';
  steps: number;
  history: HistoryEntry[];
}

/** Consecutive decode failures tolerated before the run is abandoned. */
const MAX_DECODE_ATTEMPTS = 3;
/** Identical repeated actions tolerated before the loop is called stuck. */
const MAX_REPEATS = 3;

export async function runAgent(options: AgentLoopOptions): Promise<AgentOutcome> {
  const { goal, provider, tools, config } = options;
  const sleep = options.sleep ?? defaultSleep;
  const emit = (event: AgentEvent) => options.onEvent?.({ ...event, at: Date.now() });

  const history: HistoryEntry[] = [];
  const recentSignatures: string[] = [];
  let step = 0;

  for (step = 1; step <= config.maxSteps; step += 1) {
    throwIfAborted(options.signal);

    emit({ kind: 'status', message: 'Observing the page', step });
    const snapshot = await tools.snapshot({ textBudget: config.textBudget, elementBudget: config.elementBudget });

    throwIfAborted(options.signal);
    emit({ kind: 'status', message: 'Deciding with ' + provider.name, step });

    const action = await decideWithRetries(options, snapshot, history, step, emit);
    if (!action) {
      return finish(history, step, 'stalled', 'The model could not produce a valid action after several attempts.', emit);
    }

    emit({ kind: 'action', message: describeAction(action), action, step });

    if (action.tool === 'finish') {
      const answer = action.answer ?? 'Goal complete.';
      return finish(history, step, 'done', answer, emit);
    }

    if (action.tool === 'ask') {
      const question = action.question ?? 'The agent needs more information.';
      const reply = await options.answerQuestion?.(question);

      if (reply === undefined) {
        return finish(history, step, 'stopped', 'Stopped waiting for an answer to: ' + question, emit);
      }

      history.push({ action, result: { ok: true, message: 'User answered: ' + reply } });
      emit({ kind: 'result', message: 'User answered: ' + reply, step });
      continue;
    }

    // Loop detection: an agent repeating itself is not making progress.
    const signature = signatureOf(action);
    recentSignatures.push(signature);
    if (countTrailing(recentSignatures, signature) >= MAX_REPEATS) {
      return finish(
        history,
        step,
        'stalled',
        'Stopped: the agent repeated the same action ' + MAX_REPEATS + ' times without progress.',
        emit
      );
    }

    const decision = assessAction(action, snapshot, config);

    if (decision.risk === 'blocked') {
      const result: ToolResult = { ok: false, message: decision.reason, risk: 'blocked' };
      history.push({ action, result });
      emit({ kind: 'warning', message: decision.reason, step });
      continue;
    }

    if (decision.requiresApproval) {
      emit({ kind: 'approval', message: decision.reason, action, step });
      const approved = (await options.approve?.({ action, decision, snapshot })) ?? false;

      if (!approved) {
        const result: ToolResult = { ok: false, message: 'You declined this action.', risk: decision.risk };
        history.push({ action, result });
        emit({ kind: 'result', message: 'Declined: ' + describeAction(action), step });
        continue;
      }
    }

    throwIfAborted(options.signal);

    let result: ToolResult;
    try {
      result = await tools.execute(action);
    } catch (error) {
      if (isAbort(error)) throw error;
      result = { ok: false, message: describeError(error) };
    }

    result.risk = result.risk ?? decision.risk;
    history.push({ action, result });
    emit({ kind: 'result', message: result.message, action, step });

    await sleep(result.changed ? 400 : 150);
  }

  return finish(
    history,
    config.maxSteps,
    'exhausted',
    'Reached the ' + config.maxSteps + '-step limit without finishing. Raise the limit in options or narrow the task.',
    emit
  );
}

/**
 * Asks the model for an action, feeding validation failures back as hints so a
 * small model gets a chance to repair its own output.
 */
async function decideWithRetries(
  options: AgentLoopOptions,
  snapshot: PageSnapshot,
  history: HistoryEntry[],
  step: number,
  emit: (event: AgentEvent) => void
): Promise<AgentAction | null> {
  const elementIds = new Set(snapshot.elements.map((element) => element.id));
  const hints: string[] = [];

  for (let attempt = 1; attempt <= MAX_DECODE_ATTEMPTS; attempt += 1) {
    throwIfAborted(options.signal);

    try {
      // Copies, not references: a provider must not be able to mutate the
      // loop's own state, and the arrays keep growing after this call.
      const raw = await options.provider.decide({
        goal: options.goal,
        snapshot,
        history: history.slice(),
        hints: hints.slice(),
        signal: options.signal
      });

      return validateAction(raw, {
        elementIds,
        allowCrossOrigin: options.config.allowCrossOrigin,
        currentOrigin: snapshot.origin
      });
    } catch (error) {
      if (isAbort(error)) throw error;

      // Only decode and validation problems are retryable. A backend that is
      // down will not fix itself by being asked again.
      const hint =
        error instanceof ActionValidationError
          ? error.hint
          : error instanceof JsonExtractionError
            ? 'Your last reply was not valid JSON. Reply with only a JSON object.'
            : null;

      if (!hint) throw error;

      hints.push(hint);
      emit({
        kind: 'warning',
        message: 'Attempt ' + attempt + '/' + MAX_DECODE_ATTEMPTS + ' rejected: ' + describeError(error),
        step
      });
    }
  }

  return null;
}

function finish(
  history: HistoryEntry[],
  steps: number,
  status: AgentOutcome['status'],
  answer: string,
  emit: (event: AgentEvent) => void
): AgentOutcome {
  emit({ kind: status === 'done' ? 'done' : 'warning', message: answer, step: steps });
  return { answer, status, steps, history };
}

export function describeAction(action: AgentAction): string {
  const parts: string[] = [action.tool];

  if (action.targetId) parts.push(action.targetId);
  if (action.text !== undefined) parts.push(JSON.stringify(truncate(action.text, 60)));
  if (action.value) parts.push(action.value);
  if (action.url) parts.push(action.url);
  if (action.key) parts.push(action.key);
  if (action.direction) parts.push(action.direction);

  return parts.join(' ') + ' - ' + action.reason;
}

/** Identity of an action for loop detection. */
export function signatureOf(action: AgentAction): string {
  return [action.tool, action.targetId ?? '', action.text ?? '', action.value ?? '', action.url ?? '', action.direction ?? ''].join('|');
}

/** Counts how many times `value` appears at the end of the list. */
export function countTrailing(values: string[], value: string): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0 && values[index] === value; index -= 1) count += 1;
  return count;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Agent stopped.', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
