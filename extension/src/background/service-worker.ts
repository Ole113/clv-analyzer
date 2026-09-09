import type { SnapshotPayload } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import type { CaptureMessage, CaptureResponse } from "../content/shared/messages";
import { runClosingWork } from "./closing-worker";

const QUEUE_KEY = "clv:queue";
const ALARM = "clv:flush";
const CLOSING_ALARM = "clv:closing";

interface QueueItem {
  payload: SnapshotPayload;
  queuedAt: string;
  attempts: number;
}

async function getQueue(): Promise<QueueItem[]> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
}

async function setQueue(items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: items });
  await chrome.action?.setBadgeText?.({ text: items.length ? String(items.length) : "" });
}

async function post(payload: SnapshotPayload): Promise<{ ok: boolean; status?: string; error?: string }> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) {
    return { ok: false, error: "not configured -- open the extension options" };
  }

  const response = await fetch(apiUrl(settings.backendUrl, "/api/snapshots"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
    body: JSON.stringify({ ...payload, sourceDevice: settings.deviceLabel || null }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, error: `server ${response.status}: ${text.slice(0, 180)}` };
  }
  const body = (await response.json().catch(() => ({}))) as { status?: string };
  return { ok: true, status: body.status };
}

/**
 * Captures happen mid-session, often on a laptop that may be off the tailnet for a moment. A
 * failed POST is queued and retried rather than dropped -- a silently lost pick would quietly
 * bias the CLV sample.
 */
async function enqueue(payload: SnapshotPayload): Promise<void> {
  const queue = await getQueue();
  queue.push({ payload, queuedAt: new Date().toISOString(), attempts: 0 });
  await setQueue(queue.slice(-200));
}

async function flushQueue(): Promise<void> {
  const queue = await getQueue();
  if (queue.length === 0) return;

  const remaining: QueueItem[] = [];
  for (const item of queue) {
    try {
      const result = await post(item.payload);
      if (!result.ok) remaining.push({ ...item, attempts: item.attempts + 1 });
    } catch {
      remaining.push({ ...item, attempts: item.attempts + 1 });
    }
  }
  await setQueue(remaining);
}

chrome.runtime.onMessage.addListener((message: CaptureMessage | { type: string }, _sender, sendResponse) => {
  if (message?.type === "clv:capture") {
    const payload = (message as CaptureMessage).payload;
    (async () => {
      try {
        const result = await post(payload);
        if (result.ok) {
          sendResponse({ ok: true, status: result.status } satisfies CaptureResponse);
          return;
        }
        // Configuration problems are worth surfacing immediately; transport problems are queued.
        if (result.error?.startsWith("not configured")) {
          sendResponse({ ok: false, error: result.error } satisfies CaptureResponse);
          return;
        }
        await enqueue(payload);
        sendResponse({ ok: true, queued: true, error: result.error } satisfies CaptureResponse);
      } catch (error) {
        await enqueue(payload);
        sendResponse({
          ok: true,
          queued: true,
          error: error instanceof Error ? error.message : "network error",
        } satisfies CaptureResponse);
      }
    })();
    return true;
  }

  if (message?.type === "clv:test-connection") {
    (async () => {
      try {
        // The options page passes what is currently typed in, so Test works before Save.
        const typed = message as { backendUrl?: string; apiKey?: string };
        const settings = await loadSettings();
        const backendUrl = typed.backendUrl || settings.backendUrl;
        if (!backendUrl) {
          sendResponse({ ok: false, error: "no backend URL set" });
          return;
        }
        const response = await fetch(apiUrl(backendUrl, "/api/health"));
        const body = await response.json().catch(() => ({}));
        sendResponse({ ok: response.ok, status: response.status, body });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "unreachable" });
      }
    })();
    return true;
  }

  return false;
});

chrome.alarms.create(ALARM, { periodInMinutes: 1 });
// Closing reads happen here rather than on the server: only this browser is logged in and past
// the sites' bot check. The server still decides which picks are due.
chrome.alarms.create(CLOSING_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void flushQueue();
  if (alarm.name === CLOSING_ALARM) {
    void runClosingWork().catch((error) => console.warn("[CLV Analyzer] closing work failed:", error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue();
  void runClosingWork().catch(() => undefined);
});
