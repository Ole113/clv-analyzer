import type { SnapshotPayload } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import type {
  CaptureMessage,
  CaptureResponse,
  TrackedLookupMessage,
  TrackedLookupResponse,
  UntrackMessage,
  UntrackResponse,
  PpTokenMessage,
  OddsLookupMessage,
  OddsLookupResponse,
} from "../content/shared/messages";
import { runClosingWork } from "./closing-worker";
import { runOddsPreviewWork } from "./odds-preview-worker";
import { ensureServerToken, storeToken } from "./pp-token";

const QUEUE_KEY = "clv:queue";
const ALARM = "clv:flush";
const CLOSING_ALARM = "clv:closing";

interface QueueItem {
  payload: SnapshotPayload;
  queuedAt: string;
  attempts: number;
}

/**
 * How many times a queued capture is retried before it is dropped.
 *
 * The queue exists for transport failures -- a laptop off the tailnet for a moment -- and those
 * clear. A payload the server *rejects* (a spread with no team on it, say) never will, and without
 * a cap it was re-POSTed every 60 seconds for as long as the browser stayed open, with the user
 * already told at capture time why it failed. Twenty minutes of retries is far longer than any
 * real outage this queue is meant to cover.
 */
const MAX_QUEUE_ATTEMPTS = 20;

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
    // Prefer the server's own explanation ("This spread does not say which team...") over a bare
    // status code -- that sentence is what the board shows the user.
    const text = await response.text().catch(() => "");
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // not JSON; the raw text is the best available detail
    }
    return { ok: false, error: detail || `server ${response.status}` };
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
  const retry = (item: QueueItem, why: string) => {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_QUEUE_ATTEMPTS) {
      console.warn(
        `[CLV Analyzer] giving up on a queued capture after ${attempts} attempts (${why}):`,
        item.payload.row.player ?? item.payload.row.selectionName ?? item.payload.row.statMarket
      );
      return;
    }
    remaining.push({ ...item, attempts });
  };

  for (const item of queue) {
    try {
      const result = await post(item.payload);
      if (!result.ok) retry(item, result.error ?? "rejected");
    } catch (error) {
      retry(item, error instanceof Error ? error.message : "network error");
    }
  }
  await setQueue(remaining);
}

/** Shared preflight for the calls that need a configured backend. */
async function configured(): Promise<{ backendUrl: string; apiKey: string } | null> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) return null;
  return { backendUrl: settings.backendUrl, apiKey: settings.apiKey };
}

const WARMER_ID = "clv-dashboard-warm";

/**
 * Runs the one-line warm-up script on the dashboard, whatever origin it lives at.
 *
 * It cannot be a manifest `content_scripts` entry because the manifest is static and the backend
 * URL is not -- it is a tailnet host, a localhost port, or whatever the user typed. So it is
 * registered here from the saved setting, and re-registered whenever that setting changes.
 *
 * Silently does nothing when Chrome has not granted host access to that origin (the options page
 * asks for it on Save). That is the correct outcome rather than an error: without the grant the
 * captures do not work either, and the user is already told so there.
 */
async function registerDashboardWarmer(): Promise<void> {
  try {
    const settings = await loadSettings();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WARMER_ID] });
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [WARMER_ID] });

    if (!settings.backendUrl) return;
    const origin = `${new URL(settings.backendUrl).origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [origin] }))) return;

    await chrome.scripting.registerContentScripts([
      {
        id: WARMER_ID,
        matches: [origin],
        js: ["content/dashboard-warm.js"],
        runAt: "document_idle",
      },
    ]);
  } catch (error) {
    console.warn("[CLV Analyzer] could not register the dashboard warmer:", error);
  }
}

// The backend URL is saved from the options page, which runs in its own context -- so the worker
// finds out the same way anything else does, and re-points the warmer at the new origin.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.backendUrl) void registerDashboardWarmer();
});

chrome.runtime.onMessage.addListener((message: CaptureMessage | { type: string }, sender, sendResponse) => {
  if (message?.type === "clv:pp-token") {
    // Only from a content script actually running on PropProfessor. A message claiming to carry
    // their token from anywhere else has no business being trusted.
    const from = sender.url ?? "";
    if (/^https:\/\/www\.propprofessor\.com\//.test(from)) {
      void storeToken((message as PpTokenMessage).token);
    }
    return false;
  }

  if (message?.type === "clv:warm") {
    // The dashboard was just opened. Make sure the server can read the odds screen before anyone
    // clicks anything, rather than discovering it cannot on the first click.
    void ensureServerToken();
    return false;
  }

  if (message?.type === "clv:odds-lookup") {
    (async () => {
      try {
        const settings = await configured();
        if (!settings) {
          sendResponse({ ok: false, error: "not configured -- open the extension options" });
          return;
        }
        // The server does the read, but only this extension can supply the session it needs, so
        // the token is pushed ahead of the request rather than after it fails. Awaited, unlike
        // everywhere else it is called: here it is on the critical path of something a person is
        // watching.
        await ensureServerToken();

        const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-lookup"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
          body: JSON.stringify((message as OddsLookupMessage).pick),
        });
        if (!response.ok) {
          sendResponse({ ok: false, error: `server ${response.status}` });
          return;
        }
        const body = (await response.json()) as { preview?: OddsLookupResponse["preview"] };
        sendResponse({ ok: true, preview: body.preview } satisfies OddsLookupResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "odds lookup failed",
        } satisfies OddsLookupResponse);
      }
    })();
    return true;
  }

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

  if (message?.type === "clv:tracked") {
    (async () => {
      try {
        const settings = await configured();
        if (!settings) {
          sendResponse({ ok: false, error: "not configured" } satisfies TrackedLookupResponse);
          return;
        }
        const response = await fetch(apiUrl(settings.backendUrl, "/api/tracked"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
          body: JSON.stringify({ matchKeys: (message as TrackedLookupMessage).matchKeys }),
        });
        if (!response.ok) {
          sendResponse({ ok: false, error: `server ${response.status}` } satisfies TrackedLookupResponse);
          return;
        }
        const body = (await response.json()) as { tracked?: { matchKey: string }[] };
        sendResponse({
          ok: true,
          tracked: (body.tracked ?? []).map((t) => t.matchKey),
        } satisfies TrackedLookupResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "lookup failed",
        } satisfies TrackedLookupResponse);
      }
    })();
    return true;
  }

  if (message?.type === "clv:untrack") {
    (async () => {
      try {
        const settings = await configured();
        if (!settings) {
          sendResponse({ ok: false, error: "not configured -- open the extension options" } satisfies UntrackResponse);
          return;
        }
        const response = await fetch(apiUrl(settings.backendUrl, "/api/tracked"), {
          method: "DELETE",
          headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
          body: JSON.stringify({ matchKey: (message as UntrackMessage).matchKey }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          sendResponse({ ok: false, error: body.error ?? `server ${response.status}` } satisfies UntrackResponse);
          return;
        }
        sendResponse({ ok: true } satisfies UntrackResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "remove failed",
        } satisfies UntrackResponse);
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
    // Cheap, and it is what keeps the Odds modal on its fast path: the server holds the screen
    // token in memory only, so a restart leaves it unable to read until this pushes it back.
    void ensureServerToken();
    // The real closing reads run first, always: an on-demand odds-preview burst must never delay
    // a read a pick only gets one scheduled shot at.
    void runClosingWork()
      .catch((error) => console.warn("[CLV Analyzer] closing work failed:", error))
      .then(() => runOddsPreviewWork())
      .catch((error) => console.warn("[CLV Analyzer] odds preview work failed:", error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue();
  // Up front rather than on demand: `chrome.storage.session` is cleared when Chrome closes, so at
  // this moment nothing anywhere has a screen token, and without this the first Odds click of the
  // day would be the thing that goes and fetches one.
  void ensureServerToken();
  // Registered scripts normally survive a browser restart, so this is a repair rather than the
  // usual path -- but a registration lost to a crash or a profile copy would otherwise stay lost.
  void registerDashboardWarmer();
  void runClosingWork().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureServerToken();
  void registerDashboardWarmer();
});
