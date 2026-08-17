/**
 * Side panel controller.
 *
 * Owns the run lifecycle and all user interaction. Approvals and questions are
 * rendered inline rather than through window.confirm/prompt so the user can see
 * the full action and the reason it was flagged before deciding.
 */

import { runAgent, type ApprovalRequest } from './agent/loop';
import { describeAction } from './agent/loop';
import { loadSettings } from './core/settings';
import { BACKEND_LABELS, describeFix, resolveProvider } from './llm';
import { ChromeBrowserTools } from './tools/browser';
import type { AgentEvent, LlmProvider } from './types';

const goalInput = required<HTMLTextAreaElement>('#goal');
const runButton = required<HTMLButtonElement>('#run');
const stopButton = required<HTMLButtonElement>('#stop');
const clearButton = required<HTMLButtonElement>('#clear');
const optionsButton = required<HTMLButtonElement>('#openOptions');
const traceElement = required<HTMLDivElement>('#trace');
const interaction = required<HTMLElement>('#interaction');
const backendLabel = required<HTMLSpanElement>('#backendLabel');
const backendDot = required<HTMLSpanElement>('#backendDot');
const localityBadge = required<HTMLSpanElement>('#localityBadge');
const versionLabel = required<HTMLSpanElement>('#version');

let controller: AbortController | null = null;
let provider: LlmProvider | null = null;

versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;

runButton.addEventListener('click', () => void start());
stopButton.addEventListener('click', () => controller?.abort());
optionsButton.addEventListener('click', () => void chrome.runtime.openOptionsPage());
clearButton.addEventListener('click', () => resetTrace());

goalInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void start();
  }
});

void showConfiguredBackend();

async function showConfiguredBackend(): Promise<void> {
  const settings = await loadSettings();
  backendLabel.textContent =
    settings.backend === 'auto' ? 'Auto: first available backend' : BACKEND_LABELS[settings.backend];
  setDot('unknown');
}

async function start(): Promise<void> {
  const goal = goalInput.value.trim();

  if (!goal) {
    append({ kind: 'error', message: 'Enter a goal first.' });
    goalInput.focus();
    return;
  }

  setRunning(true);
  resetTrace(true);
  clearInteraction();
  controller = new AbortController();

  try {
    const settings = await loadSettings();

    setDot('busy');
    const { provider: resolved, skipped } = await resolveProvider(
      settings,
      (message) => append({ kind: 'status', message }),
      controller.signal
    );
    provider = resolved;

    for (const entry of skipped) {
      append({ kind: 'warning', message: BACKEND_LABELS[entry.backend] + ' skipped: ' + entry.reason });
    }

    backendLabel.textContent = provider.name;
    localityBadge.textContent = provider.locality.toLowerCase().includes('remote') ? 'REMOTE' : 'LOCAL';
    setDot('ok');
    append({ kind: 'model', message: provider.name + ' - ' + provider.locality });

    const outcome = await runAgent({
      goal,
      provider,
      tools: new ChromeBrowserTools(),
      config: settings,
      signal: controller.signal,
      onEvent: append,
      approve: requestApproval,
      answerQuestion: askUser
    });

    if (outcome.status === 'done') {
      append({ kind: 'done', message: outcome.answer });
    }
  } catch (error) {
    if (isAbortError(error)) {
      append({ kind: 'status', message: 'Stopped.' });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      append({ kind: 'error', message });

      const fix = describeFix(error);
      if (fix) append({ kind: 'warning', message: fix });

      setDot('error');
    }
  } finally {
    await provider?.dispose().catch(() => undefined);
    provider = null;
    controller = null;
    clearInteraction();
    setRunning(false);
  }
}

/* -------------------------------------------------------------------------- */
/* Inline approval and questions                                               */
/* -------------------------------------------------------------------------- */

function requestApproval(request: ApprovalRequest): Promise<boolean> {
  const destructive = request.decision.risk === 'destructive';

  return new Promise<boolean>((resolve) => {
    interaction.hidden = false;
    interaction.className = 'interaction' + (destructive ? ' destructive' : '');
    interaction.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = destructive ? 'Destructive action needs approval' : 'Approval needed';

    const why = document.createElement('p');
    why.textContent = request.decision.reason;

    const what = document.createElement('p');
    const code = document.createElement('code');
    // textContent throughout: action text is model output and must never be
    // interpreted as markup.
    code.textContent = describeAction(request.action);
    what.append(code);

    const row = document.createElement('div');
    row.className = 'button-row';

    const allow = document.createElement('button');
    allow.className = 'primary';
    allow.textContent = 'ALLOW ONCE';

    const deny = document.createElement('button');
    deny.className = 'secondary';
    deny.textContent = 'SKIP';

    const settle = (value: boolean) => {
      clearInteraction();
      resolve(value);
    };

    allow.addEventListener('click', () => settle(true));
    deny.addEventListener('click', () => settle(false));
    controller?.signal.addEventListener('abort', () => settle(false), { once: true });

    row.append(allow, deny);
    interaction.append(heading, why, what, row);
    allow.focus();
  });
}

function askUser(question: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    interaction.hidden = false;
    interaction.className = 'interaction';
    interaction.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = 'The agent has a question';

    const text = document.createElement('p');
    text.textContent = question;

    const field = document.createElement('input');
    field.type = 'text';
    field.placeholder = 'Your answer';

    const row = document.createElement('div');
    row.className = 'button-row';

    const send = document.createElement('button');
    send.className = 'primary';
    send.textContent = 'ANSWER';

    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'STOP';

    const settle = (value: string | undefined) => {
      clearInteraction();
      resolve(value);
    };

    send.addEventListener('click', () => settle(field.value.trim() || 'No answer given.'));
    cancel.addEventListener('click', () => settle(undefined));
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') settle(field.value.trim() || 'No answer given.');
    });
    controller?.signal.addEventListener('abort', () => settle(undefined), { once: true });

    row.append(send, cancel);
    interaction.append(heading, text, field, row);
    field.focus();
  });
}

function clearInteraction(): void {
  interaction.hidden = true;
  interaction.replaceChildren();
}

/* -------------------------------------------------------------------------- */
/* Trace                                                                       */
/* -------------------------------------------------------------------------- */

function append(event: AgentEvent): void {
  traceElement.querySelector('.trace-empty')?.remove();

  const node = document.createElement('div');
  node.className = 'event ' + event.kind;

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = event.step ? '[' + event.step + '] ' + event.kind : event.kind;

  const body = document.createElement('span');
  body.textContent = event.message;

  node.append(tag, body);
  traceElement.append(node);
  traceElement.scrollTop = traceElement.scrollHeight;
}

function resetTrace(silent = false): void {
  traceElement.replaceChildren();
  if (!silent) {
    const empty = document.createElement('div');
    empty.className = 'trace-empty';
    empty.textContent = 'Ready to stuff.';
    traceElement.append(empty);
  }
}

function setRunning(running: boolean): void {
  runButton.disabled = running;
  stopButton.disabled = !running;
  goalInput.disabled = running;
}

function setDot(state: 'ok' | 'busy' | 'error' | 'unknown'): void {
  backendDot.dataset.state = state;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing element: ' + selector);
  return element;
}
