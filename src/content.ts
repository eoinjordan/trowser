/**
 * Page bridge.
 *
 * Injected into the active tab for the duration of a task. This file is only
 * the Chrome messaging wrapper; the observation and execution logic lives in
 * src/page/ so it can be tested against a real document.
 */

import type { AgentAction, ToolResult } from './types';
import { executeAction } from './page/actions';
import { captureSnapshot, type SnapshotRequest } from './page/snapshot';

declare global {
  interface Window {
    __trowserInstalled?: boolean;
  }
}

if (!window.__trowserInstalled) {
  window.__trowserInstalled = true;

  chrome.runtime.onMessage.addListener(
    (message: Record<string, unknown>, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (message?.source !== 'trowser') return undefined;

      if (message.type === 'ping') {
        sendResponse({ ok: true });
        return undefined;
      }

      if (message.type === 'snapshot') {
        try {
          sendResponse(captureSnapshot((message.request ?? {}) as SnapshotRequest));
        } catch (error) {
          sendResponse({ __error: describe(error) });
        }
        return undefined;
      }

      if (message.type === 'execute') {
        void executeAction(message.action as AgentAction)
          .then(sendResponse)
          .catch((error: unknown) => sendResponse({ ok: false, message: describe(error) } satisfies ToolResult));
        // Keeps the message channel open for the async response.
        return true;
      }

      return undefined;
    }
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
