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
  OddsLookupPick,
  OddsTerminalLookupMessage,
  OddsTerminalPathMessage,
  OddsTerminalPathResponse,
  OddsTerminalResultMessage,
  OddsTerminalSnapshotMessage,
  OddsTerminalSnapshotResponse,
  KellySettingsMessage,
  KellySettingsResponse,
} from "../content/shared/messages";
import { storeToken } from "./pp-token";

const QUEUE_KEY = "clv:queue";
const ALARM = "clv:flush";

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

/**
 * Odds Terminal lookups waiting on the tab the user's click opened.
 *
 * ## Why the worker holds state at all
 *
 * Every other source answers inside one request. This one is a three-hop round trip -- the board
 * opens a tab, the relay in that tab asks what to fetch, then reports what it read -- and the
 * modal is sitting on a single `sendMessage` await across the whole thing. So the worker parks the
 * modal's `sendResponse` here and resolves it when the third hop lands.
 *
 * ## Why an unguessable id is the authentication
 *
 * The worker cannot check that a snapshot message came from Odds Terminal the way the `clv:pp-token`
 * handler below checks its sender, because doing so would mean naming that host in background code
 * -- which is exactly what this design forbids, and what the automation guard asserts is absent.
 * The pending id does that job instead: a result is only honoured if it quotes an id this worker
 * minted itself, that is still within its timeout, and that has not already been answered. Each
 * entry is consumed on first use, so a reload of the opened tab cannot replay a read either.
 *
 * Nothing here is persisted. A worker restart drops every pending lookup, which is correct: the
 * modal that was waiting is gone too, and a read that survived its own asker would be precisely
 * the unattended automation this whole arrangement exists to prevent.
 */
interface PendingOddsTerminal {
  pick: OddsLookupPick;
  /** The relative path the relay should fetch, resolved from the server before the relay asks. */
  path: Promise<OddsTerminalPathResponse>;
  respond: (response: OddsLookupResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingOddsTerminal = new Map<string, PendingOddsTerminal>();

/**
 * How long a lookup may stay parked.
 *
 * Long enough for a cold tab to clear Cloudflare and sign-in to be noticed, short enough that a
 * user who closed the tab gets a real message rather than a spinner forever. The relay has its own,
 * shorter timeout on the fetch itself; this one covers everything that can go wrong around it --
 * the tab never loading, the user closing it, the content script never being injected at all.
 */
const ODDS_TERMINAL_TIMEOUT_MS = 30_000;

function settleOddsTerminal(requestId: string, response: OddsLookupResponse): void {
  const entry = pendingOddsTerminal.get(requestId);
  if (!entry) return;
  pendingOddsTerminal.delete(requestId);
  clearTimeout(entry.timer);
  entry.respond(response);
}

/** Asks the server what the relay should fetch. Returns a relative path, never an origin. */
async function oddsTerminalPath(pick: OddsLookupPick): Promise<OddsTerminalPathResponse> {
  const settings = await configured();
  if (!settings) return { ok: false, reason: "not configured -- open the extension options" };
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-verdict"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ ...pick, plan: true }),
    });
    if (!response.ok) return { ok: false, reason: `server ${response.status}` };
    const body = (await response.json()) as { ok?: boolean; path?: string; reason?: string };
    return body?.ok && body.path
      ? { ok: true, path: body.path }
      : { ok: false, reason: body?.reason ?? "Odds Terminal cannot answer this market." };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not reach the backend",
    };
  }
}

/** Asks the server which fixture the snapshot names, and what to stream next. */
async function oddsTerminalFixture(
  pick: OddsLookupPick,
  snapshot: unknown
): Promise<OddsTerminalSnapshotResponse> {
  const settings = await configured();
  if (!settings) return { ok: false, reason: "not configured -- open the extension options" };
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-verdict"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ ...pick, snapshot }),
    });
    if (!response.ok) return { ok: false, reason: `server ${response.status}` };
    const body = (await response.json()) as OddsTerminalSnapshotResponse;
    return body?.ok && body.streamPath
      ? { ok: true, streamPath: body.streamPath, fixture: body.fixture }
      : { ok: false, reason: body?.reason ?? "Odds Terminal is not listing this game." };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not reach the backend",
    };
  }
}

/** Turns the relayed stream into the verdict the modal renders. The server does the computing; it
 *  never does the fetching. */
async function oddsTerminalVerdict(
  pick: OddsLookupPick,
  stream: unknown
): Promise<OddsLookupResponse> {
  const settings = await configured();
  if (!settings) return { ok: false, error: "not configured -- open the extension options" };
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-verdict"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ ...pick, stream }),
    });
    if (!response.ok) return { ok: false, error: `server ${response.status}` };
    const body = (await response.json()) as { preview?: OddsLookupResponse["preview"] };
    return { ok: true, preview: body.preview };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "odds lookup failed",
    };
  }
}

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

  if (message?.type === "clv:odds-terminal-lookup") {
    const { requestId, pick } = message as OddsTerminalLookupMessage;
    // The path is resolved immediately rather than when the relay asks for it, so the server round
    // trip overlaps with the tab loading instead of following it. The relay awaits this promise.
    const path = oddsTerminalPath(pick);
    const timer = setTimeout(() => {
      settleOddsTerminal(requestId, {
        ok: false,
        error:
          "Odds Terminal did not answer. Check that the tab opened (a blocked pop-up would stop it) " +
          "and that you are signed in there, then hit Refresh.",
      });
    }, ODDS_TERMINAL_TIMEOUT_MS);
    pendingOddsTerminal.set(requestId, { pick, path, respond: sendResponse, timer });

    // A plan the server refuses ("this source does not carry that market") is final and there is
    // nothing for the tab to do, so it is answered now rather than left to time out.
    void path.then((resolved) => {
      if (!resolved.ok) settleOddsTerminal(requestId, { ok: false, error: resolved.reason });
    });
    return true;
  }

  if (message?.type === "clv:odds-terminal-path") {
    const { requestId } = message as OddsTerminalPathMessage;
    const entry = pendingOddsTerminal.get(requestId);
    // An id nobody is waiting on gets nothing. This is what stops a reload of the opened tab, or
    // any other page, from provoking a read.
    if (!entry) {
      sendResponse({ ok: false, reason: "This lookup is no longer waiting for an answer." } satisfies OddsTerminalPathResponse);
      return false;
    }
    void entry.path.then(sendResponse);
    return true;
  }

  if (message?.type === "clv:odds-terminal-snapshot") {
    const { requestId, snapshot } = message as OddsTerminalSnapshotMessage;
    const entry = pendingOddsTerminal.get(requestId);
    // Same gate as the path hop: an id nobody is waiting on gets nothing.
    if (!entry) {
      sendResponse({ ok: false, reason: "This lookup is no longer waiting for an answer." } satisfies OddsTerminalSnapshotResponse);
      return false;
    }
    void oddsTerminalFixture(entry.pick, snapshot).then(sendResponse);
    return true;
  }

  if (message?.type === "clv:odds-terminal-result") {
    const result = message as OddsTerminalResultMessage;
    const entry = pendingOddsTerminal.get(result.requestId);
    if (!entry) return false; // Timed out, already answered, or never ours.
    if (!result.ok) {
      settleOddsTerminal(result.requestId, { ok: false, error: result.reason ?? "Odds Terminal could not be read." });
      return false;
    }
    void oddsTerminalVerdict(entry.pick, result.stream).then((response) => {
      settleOddsTerminal(result.requestId, response);
    });
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
        const pick = (message as OddsLookupMessage).pick;
        // The Odds API is the only source now (PropProfessor automation was disabled after that
        // account was banned, 2026-09), and it authenticates with its own key -- there is no
        // session to push ahead of the request the way there used to be.
        const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-lookup"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
          body: JSON.stringify(pick),
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

  if (message?.type === "clv:kelly-settings") {
    (async () => {
      try {
        const settings = await configured();
        if (!settings) {
          sendResponse({ ok: false, error: "not configured" } satisfies KellySettingsResponse);
          return;
        }
        const save = (message as KellySettingsMessage).save;
        const response = await fetch(apiUrl(settings.backendUrl, "/api/kelly-settings"), {
          method: save ? "POST" : "GET",
          headers: save
            ? { "content-type": "application/json", "x-api-key": settings.apiKey }
            : { "x-api-key": settings.apiKey },
          body: save ? JSON.stringify(save) : undefined,
        });
        if (!response.ok) {
          sendResponse({ ok: false, error: `server ${response.status}` } satisfies KellySettingsResponse);
          return;
        }
        const body = (await response.json()) as KellySettingsResponse;
        sendResponse({ ok: true, kelly: body.kelly } satisfies KellySettingsResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "network error",
        } satisfies KellySettingsResponse);
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

// There used to be a second, `CLOSING_ALARM` alarm here that read PropProfessor's odds screen
// every minute -- both the scheduled closing-read queue and the Odds modal's on-demand queue rode
// on it. That automation is what got the PropProfessor account banned (2026-09), so it is gone:
// closing-line capture is disabled for now rather than rewired, and the Odds modal answers from
// The Odds API inside its own request instead of queuing. `closing-worker.ts`,
// `odds-preview-worker.ts` and `pp-token.ts`'s token minting all still exist but nothing calls
// them any more.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void flushQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue();
  // Registered scripts normally survive a browser restart, so this is a repair rather than the
  // usual path -- but a registration lost to a crash or a profile copy would otherwise stay lost.
  void registerDashboardWarmer();
});

chrome.runtime.onInstalled.addListener(() => {
  void registerDashboardWarmer();
});
