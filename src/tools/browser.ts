/**
 * Side-panel half of the tool bridge.
 *
 * Owns tab resolution, content-script injection and message passing. Keeping
 * this separate from the agent loop means the loop can be tested against a
 * fake implementation of BrowserTools with no Chrome APIs in play.
 */

import type { AgentAction, PageSnapshot, ToolResult } from '../types';

export interface SnapshotRequest {
  textBudget: number;
  elementBudget: number;
}

export interface BrowserTools {
  snapshot(request: SnapshotRequest): Promise<PageSnapshot>;
  execute(action: AgentAction): Promise<ToolResult>;
}

/** Pages Chrome forbids extensions from scripting. */
const RESTRICTED_SCHEMES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://', 'view-source:'];
const WEBSTORE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

export class TabUnavailableError extends Error {
  readonly fix = 'Open a normal web page in the active tab and run the task again.';

  constructor(message: string) {
    super(message);
    this.name = 'TabUnavailableError';
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) throw new TabUnavailableError('No active tab was found.');

  const url = tab.url ?? '';
  if (!url) {
    throw new TabUnavailableError('Trowser cannot read this tab. Reload the page and try again.');
  }
  if (RESTRICTED_SCHEMES.some((scheme) => url.startsWith(scheme))) {
    throw new TabUnavailableError('Chrome does not allow extensions to automate ' + new URL(url).protocol + ' pages.');
  }
  if (WEBSTORE_HOSTS.includes(safeHost(url))) {
    throw new TabUnavailableError('Chrome blocks extensions on the Chrome Web Store.');
  }

  return tab;
}

/** Injects the bridge if it is not already present in the tab. */
async function ensureBridge(tabId: number): Promise<void> {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { source: 'trowser', type: 'ping' });
    if (pong) return;
  } catch {
    // Not injected yet; fall through to inject.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TabUnavailableError('Could not attach to this page: ' + message);
  }
}

async function send<T>(tabId: number, message: Record<string, unknown>): Promise<T> {
  const response = await chrome.tabs.sendMessage(tabId, { source: 'trowser', ...message });

  if (response && typeof response === 'object' && '__error' in response) {
    throw new Error(String((response as { __error: unknown }).__error));
  }
  if (response === undefined) {
    throw new TabUnavailableError('The page did not respond. It may have navigated mid-task.');
  }

  return response as T;
}

export class ChromeBrowserTools implements BrowserTools {
  async snapshot(request: SnapshotRequest): Promise<PageSnapshot> {
    const tab = await getActiveTab();
    await ensureBridge(tab.id as number);
    return send<PageSnapshot>(tab.id as number, { type: 'snapshot', request });
  }

  async execute(action: AgentAction): Promise<ToolResult> {
    const tab = await getActiveTab();

    // Navigation is driven from here rather than the page, so that it works
    // even when the page blocks scripted navigation.
    if (action.tool === 'navigate' && action.url) {
      await chrome.tabs.update(tab.id as number, { url: action.url });
      await waitForTabLoad(tab.id as number);
      return { ok: true, message: 'Navigated to ' + action.url, changed: true };
    }

    await ensureBridge(tab.id as number);
    const result = await send<ToolResult>(tab.id as number, { type: 'execute', action });

    // A click that triggers navigation tears down the bridge; give the new
    // document a moment so the next snapshot lands on the loaded page.
    if (result.changed && (action.tool === 'click' || action.tool === 'key' || action.tool === 'back')) {
      await waitForTabLoad(tab.id as number, 3000).catch(() => undefined);
    }

    return result;
  }
}

/** Resolves once the tab reports complete, or after the timeout. */
export function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Let the framework paint before the next snapshot.
      setTimeout(resolve, 250);
    };

    // Typed structurally rather than as chrome.tabs.TabChangeInfo: that alias
    // has been renamed across @types/chrome releases, and only status is used.
    const listener = (updatedTabId: number, info: { status?: string }) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);

    // The tab may already be complete before the listener attaches.
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
