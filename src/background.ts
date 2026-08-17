/**
 * Service worker.
 *
 * Deliberately thin. The agent loop runs in the side panel document because
 * Chrome's Prompt API and WebGPU are available to extension documents but not
 * to service workers. This file only handles lifecycle and entry points.
 */

const OPTIONS_SHOWN_KEY = 'trowser.optionsShown.v1';

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  // Send first-time users to options so they can pick a backend before the
  // first run fails with a confusing "no backend available" message.
  if (details.reason === 'install') {
    const stored = await chrome.storage.local.get(OPTIONS_SHOWN_KEY);
    if (!stored[OPTIONS_SHOWN_KEY]) {
      await chrome.storage.local.set({ [OPTIONS_SHOWN_KEY]: true });
      await chrome.runtime.openOptionsPage().catch(() => undefined);
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-trowser') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
});
