/**
 * Options page controller.
 *
 * Every write goes through normaliseSettings, so the stored settings object is
 * always valid regardless of what the form contained. Secrets are written but
 * never read back into the DOM as plain text.
 */

import { describeAccount, getAccount, getRedirectUri, signInWithGitHubToken, signInWithGoogle, signOut, startGitHubDeviceFlow } from './integrations/auth';
import { hfWhoAmI, pickBestQuant, searchHfModels, toOllamaRef, type HfModelKind } from './integrations/hf';
import { listOllamaModels, pullOllamaModel } from './llm/ollama';
import { listOpenAiModels } from './llm/openai';
import { listWebLlmModels } from './llm/webllm';
import { BACKEND_LABELS, probeBackend } from './llm';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './core/settings';
import type { BackendId, Settings } from './types';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing element: #' + id);
  return node as T;
};

const BACKENDS: BackendId[] = ['chrome-ai', 'webllm', 'ollama', 'openai-compatible'];

/** Host permissions each backend needs, requested only when used. */
const PERMISSION_GROUPS: Array<{ id: string; label: string; origins: string[] }> = [
  { id: 'local', label: 'Local servers (Ollama, LM Studio, llama.cpp)', origins: ['http://localhost/*', 'http://127.0.0.1/*'] },
  { id: 'hf', label: 'Hugging Face (model search and weights)', origins: ['https://huggingface.co/*', 'https://*.huggingface.co/*'] },
  { id: 'github', label: 'GitHub (sign-in and skill sync)', origins: ['https://api.github.com/*'] },
  { id: 'google', label: 'Google (sign-in and backup)', origins: ['https://*.googleapis.com/*'] }
];

let settings: Settings = DEFAULT_SETTINGS;
let saveTimer: number | undefined;

void initialise();

async function initialise(): Promise<void> {
  settings = await loadSettings();

  el<HTMLSpanElement>('versionLabel').textContent = 'Trowser v' + chrome.runtime.getManifest().version;
  el<HTMLElement>('redirectUri').textContent = getRedirectUri();

  await populateWebLlmModels();
  applySettingsToForm();
  wireForm();
  wireBackendTools();
  wireHuggingFace();
  wireAccounts();

  renderPermissions();
  await refreshAccounts();
  void testAllBackends();
}

/* -------------------------------------------------------------------------- */
/* Form binding                                                                */
/* -------------------------------------------------------------------------- */

function applySettingsToForm(): void {
  el<HTMLSelectElement>('backend').value = settings.backend;
  el<HTMLSelectElement>('webllmModel').value = settings.webllmModel;
  el<HTMLInputElement>('ollamaBaseUrl').value = settings.ollamaBaseUrl;
  el<HTMLInputElement>('ollamaModel').value = settings.ollamaModel;
  el<HTMLInputElement>('openaiBaseUrl').value = settings.openaiBaseUrl;
  el<HTMLInputElement>('openaiModel').value = settings.openaiModel;
  el<HTMLInputElement>('maxSteps').value = String(settings.maxSteps);
  el<HTMLInputElement>('approveEverything').checked = settings.approveEverything;
  el<HTMLInputElement>('allowCrossOrigin').checked = settings.allowCrossOrigin;
  el<HTMLTextAreaElement>('trustedOrigins').value = settings.trustedOrigins.join('\n');
  el<HTMLInputElement>('textBudget').value = String(settings.textBudget);
  el<HTMLInputElement>('elementBudget').value = String(settings.elementBudget);
  el<HTMLInputElement>('githubClientId').value = settings.githubClientId;
  el<HTMLInputElement>('googleClientId').value = settings.googleClientId;

  // Secrets are represented by a placeholder so they are never re-rendered.
  el<HTMLInputElement>('openaiApiKey').placeholder = settings.openaiApiKey ? 'stored - type to replace' : 'only needed for remote endpoints';
  el<HTMLInputElement>('hfToken').placeholder = settings.hfToken ? 'stored - type to replace' : 'hf_...';

  updateRangeLabels();
  showRelevantBackendCards();
}

function wireForm(): void {
  const inputs: Array<[string, keyof Settings, 'value' | 'checked' | 'number' | 'lines']> = [
    ['backend', 'backend', 'value'],
    ['webllmModel', 'webllmModel', 'value'],
    ['ollamaBaseUrl', 'ollamaBaseUrl', 'value'],
    ['ollamaModel', 'ollamaModel', 'value'],
    ['openaiBaseUrl', 'openaiBaseUrl', 'value'],
    ['openaiModel', 'openaiModel', 'value'],
    ['githubClientId', 'githubClientId', 'value'],
    ['googleClientId', 'googleClientId', 'value'],
    ['maxSteps', 'maxSteps', 'number'],
    ['textBudget', 'textBudget', 'number'],
    ['elementBudget', 'elementBudget', 'number'],
    ['approveEverything', 'approveEverything', 'checked'],
    ['allowCrossOrigin', 'allowCrossOrigin', 'checked'],
    ['trustedOrigins', 'trustedOrigins', 'lines']
  ];

  for (const [id, key, kind] of inputs) {
    const node = el<HTMLInputElement>(id);
    node.addEventListener(kind === 'checked' ? 'change' : 'input', () => {
      const value =
        kind === 'checked' ? node.checked
        : kind === 'number' ? Number(node.value)
        : kind === 'lines' ? node.value.split('\n').map((line) => line.trim()).filter(Boolean)
        : node.value;

      void persist({ [key]: value } as Partial<Settings>);
      updateRangeLabels();
      if (id === 'backend') showRelevantBackendCards();
    });
  }

  // Secrets only overwrite storage when the user actually types something.
  for (const [id, key] of [['openaiApiKey', 'openaiApiKey'], ['hfToken', 'hfToken']] as const) {
    el<HTMLInputElement>(id).addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      if (value) void persist({ [key]: value } as Partial<Settings>);
    });
  }

  for (const chip of Array.from(document.querySelectorAll<HTMLButtonElement>('.chip[data-url]'))) {
    chip.addEventListener('click', () => {
      el<HTMLInputElement>('openaiBaseUrl').value = chip.dataset.url ?? '';
      void persist({ openaiBaseUrl: chip.dataset.url ?? '' });
    });
  }
}

async function persist(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  flashSaved();
}

function flashSaved(): void {
  const flag = el<HTMLElement>('savedFlag');
  flag.hidden = false;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    flag.hidden = true;
  }, 1200);
}

function updateRangeLabels(): void {
  el<HTMLElement>('maxStepsValue').textContent = el<HTMLInputElement>('maxSteps').value;
  el<HTMLElement>('textBudgetValue').textContent = el<HTMLInputElement>('textBudget').value;
  el<HTMLElement>('elementBudgetValue').textContent = el<HTMLInputElement>('elementBudget').value;
}

function showRelevantBackendCards(): void {
  const chosen = el<HTMLSelectElement>('backend').value;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('.card[data-backend]'))) {
    card.hidden = chosen !== 'auto' && card.dataset.backend !== chosen;
  }
}

/* -------------------------------------------------------------------------- */
/* Backends                                                                    */
/* -------------------------------------------------------------------------- */

async function populateWebLlmModels(): Promise<void> {
  const select = el<HTMLSelectElement>('webllmModel');
  const models = await listWebLlmModels();

  select.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label + (model.sizeMb ? ' (' + Math.round(model.sizeMb / 1024 * 10) / 10 + ' GB VRAM)' : '');
    select.append(option);
  }

  // Keep a previously chosen model selectable even if it left the catalogue.
  if (settings.webllmModel && !models.some((model) => model.id === settings.webllmModel)) {
    const option = document.createElement('option');
    option.value = settings.webllmModel;
    option.textContent = settings.webllmModel + ' (custom)';
    select.prepend(option);
  }
}

function wireBackendTools(): void {
  el<HTMLButtonElement>('testAll').addEventListener('click', () => void testAllBackends());

  el<HTMLButtonElement>('refreshOllama').addEventListener('click', async () => {
    await withButton('refreshOllama', async () => {
      const models = await listOllamaModels(settings.ollamaBaseUrl);
      fillDatalist('ollamaModels', models.map((model) => model.id));
      setStatusLine('pullStatus', models.length + ' model(s) available.');
    });
  });

  el<HTMLButtonElement>('refreshOpenai').addEventListener('click', async () => {
    await withButton('refreshOpenai', async () => {
      const models = await listOpenAiModels(settings.openaiBaseUrl, settings.openaiApiKey);
      fillDatalist('openaiModels', models.map((model) => model.id));
    });
  });

  el<HTMLButtonElement>('pullModel').addEventListener('click', () => void pullModel(el<HTMLInputElement>('pullRef').value.trim()));
}

async function pullModel(reference: string): Promise<void> {
  if (!reference) {
    setStatusLine('pullStatus', 'Enter a model name first.');
    return;
  }

  const progress = el<HTMLProgressElement>('pullProgress');
  progress.hidden = false;
  progress.value = 0;

  await withButton('pullModel', async () => {
    try {
      await pullOllamaModel(settings.ollamaBaseUrl, reference, (message, fraction) => {
        setStatusLine('pullStatus', message);
        if (typeof fraction === 'number') progress.value = fraction;
      });

      setStatusLine('pullStatus', 'Pulled ' + reference + '. Select it as the Ollama model above.');
      const models = await listOllamaModels(settings.ollamaBaseUrl);
      fillDatalist('ollamaModels', models.map((model) => model.id));
    } finally {
      progress.hidden = true;
    }
  }, 'pullStatus');
}

async function testAllBackends(): Promise<void> {
  const container = el<HTMLElement>('backendStatus');
  container.replaceChildren();

  const rows = new Map<BackendId, HTMLElement>();
  for (const backend of BACKENDS) {
    const row = createStatusRow(BACKEND_LABELS[backend], 'Checking...', 'busy');
    rows.set(backend, row);
    container.append(row);
  }

  await Promise.all(
    BACKENDS.map(async (backend) => {
      const status = await probeBackend(backend, settings);
      const row = rows.get(backend);
      if (row) updateStatusRow(row, status.ok ? 'ok' : 'error', status.detail, status.fix);
    })
  );
}

/* -------------------------------------------------------------------------- */
/* Hugging Face                                                                */
/* -------------------------------------------------------------------------- */

function wireHuggingFace(): void {
  el<HTMLButtonElement>('verifyHf').addEventListener('click', async () => {
    await withButton('verifyHf', async () => {
      const token = el<HTMLInputElement>('hfToken').value.trim() || settings.hfToken;
      const who = await hfWhoAmI(token);
      setStatusLine('hfStatus', 'Signed in to Hugging Face as ' + who.name + '.');
    }, 'hfStatus');
  });

  el<HTMLButtonElement>('hfSearch').addEventListener('click', () => void searchModels());
  el<HTMLInputElement>('hfQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void searchModels();
  });
}

async function searchModels(): Promise<void> {
  const query = el<HTMLInputElement>('hfQuery').value.trim();
  const kind = el<HTMLSelectElement>('hfKind').value as HfModelKind;
  const results = el<HTMLElement>('hfResults');

  await withButton('hfSearch', async () => {
    const models = await searchHfModels(query, kind, settings.hfToken);
    results.replaceChildren();

    if (!models.length) {
      results.append(createStatusRow('No results', 'Try a different search term.', 'error'));
      return;
    }

    for (const model of models) {
      const row = document.createElement('div');
      row.className = 'result';

      const body = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'result-name';
      name.textContent = model.repo;

      const meta = document.createElement('div');
      meta.className = 'result-meta';
      meta.textContent =
        (model.downloads ? model.downloads.toLocaleString() + ' downloads' : 'no download count') +
        (model.gated ? ' - gated, needs a token' : '');

      body.append(name, meta);

      const action = document.createElement('button');
      action.textContent = kind === 'gguf' ? 'Pull to Ollama' : 'Use in WebLLM';
      action.addEventListener('click', () => void useModel(model.repo, kind));

      row.append(body, action);
      results.append(row);
    }
  });
}

async function useModel(repo: string, kind: HfModelKind): Promise<void> {
  if (kind === 'mlc') {
    // WebLLM addresses models by their compiled model id, not the repo path.
    const modelId = repo.split('/').pop() ?? repo;
    const select = el<HTMLSelectElement>('webllmModel');

    if (!Array.from(select.options).some((option) => option.value === modelId)) {
      const option = document.createElement('option');
      option.value = modelId;
      option.textContent = modelId + ' (from Hugging Face)';
      select.prepend(option);
    }

    select.value = modelId;
    await persist({ webllmModel: modelId, backend: 'webllm' });
    el<HTMLSelectElement>('backend').value = 'webllm';
    showRelevantBackendCards();
    return;
  }

  // GGUF: resolve the best quantisation, then hand the reference to Ollama.
  setStatusLine('pullStatus', 'Resolving quantisations for ' + repo + '...');

  try {
    const { listGgufFiles } = await import('./integrations/hf');
    const files = await listGgufFiles(repo, settings.hfToken);
    const quant = pickBestQuant(files);
    const reference = toOllamaRef(repo, quant);

    el<HTMLInputElement>('pullRef').value = reference;
    setStatusLine('pullStatus', 'Ready to pull ' + reference + '. Press Pull.');
  } catch (error) {
    setStatusLine('pullStatus', describe(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                    */
/* -------------------------------------------------------------------------- */

function wireAccounts(): void {
  el<HTMLButtonElement>('githubSignIn').addEventListener('click', async () => {
    await withButton('githubSignIn', async () => {
      const handle = await startGitHubDeviceFlow(settings.githubClientId);
      setStatusLine('githubStatus', 'Enter code ' + handle.userCode + ' at ' + handle.verificationUri);
      await chrome.tabs.create({ url: handle.verificationUri });

      const account = await handle.completed;
      setStatusLine('githubStatus', describeAccount(account));
    }, 'githubStatus');
  });

  el<HTMLButtonElement>('githubTokenSignIn').addEventListener('click', async () => {
    await withButton('githubTokenSignIn', async () => {
      const account = await signInWithGitHubToken(el<HTMLInputElement>('githubToken').value);
      el<HTMLInputElement>('githubToken').value = '';
      setStatusLine('githubStatus', describeAccount(account));
    }, 'githubStatus');
  });

  el<HTMLButtonElement>('githubSignOut').addEventListener('click', async () => {
    await signOut('github');
    setStatusLine('githubStatus', 'Not signed in');
  });

  el<HTMLButtonElement>('googleSignIn').addEventListener('click', async () => {
    await withButton('googleSignIn', async () => {
      const account = await signInWithGoogle(settings.googleClientId);
      setStatusLine('googleStatus', describeAccount(account));
    }, 'googleStatus');
  });

  el<HTMLButtonElement>('googleSignOut').addEventListener('click', async () => {
    await signOut('google');
    setStatusLine('googleStatus', 'Not signed in');
  });
}

async function refreshAccounts(): Promise<void> {
  setStatusLine('githubStatus', describeAccount(await getAccount('github')));
  setStatusLine('googleStatus', describeAccount(await getAccount('google')));
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

function renderPermissions(): void {
  const container = el<HTMLElement>('permissionList');
  container.replaceChildren();

  for (const group of PERMISSION_GROUPS) {
    const row = createStatusRow(group.label, 'Checking...', 'busy');

    const button = document.createElement('button');
    button.textContent = 'Grant';
    row.append(button);
    container.append(row);

    const refresh = async () => {
      const granted = await chrome.permissions.contains({ origins: group.origins });
      updateStatusRow(row, granted ? 'ok' : 'error', granted ? 'Granted.' : 'Not granted.');
      button.textContent = granted ? 'Revoke' : 'Grant';
      button.hidden = false;
    };

    button.addEventListener('click', async () => {
      const granted = await chrome.permissions.contains({ origins: group.origins });
      // Requesting must happen directly in the click handler to keep the user
      // gesture, so no awaits precede it beyond the check above.
      if (granted) {
        await chrome.permissions.remove({ origins: group.origins });
      } else {
        await chrome.permissions.request({ origins: group.origins });
      }
      await refresh();
    });

    void refresh();
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function createStatusRow(name: string, detail: string, state: 'ok' | 'error' | 'busy'): HTMLElement {
  const row = document.createElement('div');
  row.className = 'status';
  row.dataset.state = state;

  const dot = document.createElement('span');
  dot.className = 'dot';

  const body = document.createElement('div');
  body.className = 'status-body';

  const title = document.createElement('div');
  title.className = 'status-name';
  title.textContent = name;

  const description = document.createElement('div');
  description.className = 'status-detail';
  description.textContent = detail;

  body.append(title, description);
  row.append(dot, body);
  return row;
}

function updateStatusRow(row: HTMLElement, state: 'ok' | 'error' | 'busy', detail: string, fix?: string): void {
  row.dataset.state = state;

  const description = row.querySelector('.status-detail');
  if (description) description.textContent = detail;

  row.querySelector('.status-fix')?.remove();
  if (fix) {
    const node = document.createElement('div');
    node.className = 'status-fix';
    node.textContent = fix;
    row.querySelector('.status-body')?.append(node);
  }
}

function fillDatalist(id: string, values: string[]): void {
  const list = el<HTMLDataListElement>(id);
  list.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    list.append(option);
  }
}

function setStatusLine(id: string, message: string): void {
  el<HTMLElement>(id).textContent = message;
}

/** Disables a button for the duration of an async action and reports failures. */
async function withButton(id: string, action: () => Promise<void>, statusId?: string): Promise<void> {
  const button = el<HTMLButtonElement>(id);
  const label = button.textContent;

  button.disabled = true;
  button.textContent = 'Working...';

  try {
    await action();
  } catch (error) {
    const message = describe(error);
    if (statusId) setStatusLine(statusId, message);
    else console.error('[trowser]', message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'fix' in error) {
    const fix = (error as { fix?: unknown }).fix;
    const message = error instanceof Error ? error.message : String(error);
    return typeof fix === 'string' ? message + '\n' + fix : message;
  }
  return error instanceof Error ? error.message : String(error);
}
