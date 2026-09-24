import type { SnapshotPayload } from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";
import type {
  CaptureMessage,
  CaptureResponse,
  TrackedLookupMessage,
  TrackedLookupResponse,
  UntrackMessage,
  UntrackResponse,
  OddsLookupMessage,
  OddsLookupResponse,
  OddsLookupPick,
  KellySettingsMessage,
  KellySettingsResponse,
} from "../content/shared/messages";
import type { OddsTerminalReadPlan } from "@clv/shared";
import { readOddsTerminal, OddsTerminalSignedOutError } from "./odds-terminal-read";

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

/**
 * The Odds Terminal path: plan on the server, read in this worker, compute on the server.
 *
 * Three steps rather than one because each is the only place that can do its job. The plan needs
 * the book ordering, which is a database setting. The read needs the user's own browser session,
 * which only this worker can spend. The verdict needs `buildClosingVerdict`, and a second copy of
 * that arithmetic in the extension would drift from the dashboard's silently.
 *
 * What is conspicuously absent is the shape this replaced: no pending map, no request ids, no tab,
 * no relay, no held-open `sendResponse`. The worker fetches and answers inside one message.
 */
async function oddsTerminalLookup(pick: OddsLookupPick): Promise<OddsLookupResponse> {
  const settings = await configured();
  if (!settings) return { ok: false, error: "not configured -- open the extension options" };

  const post = async (body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/odds-verdict"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`server ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  try {
    const planned = await post({ ...pick, plan: true });
    if (!planned.ok || !planned.plan) {
      // "Odds Terminal does not carry college hockey" is a real, final answer to the question
      // asked -- shown as one rather than as an error.
      return {
        ok: true,
        preview: {
          fetchedAt: new Date().toISOString(),
          ok: false,
          reason: (planned.reason as string) ?? "Odds Terminal cannot answer this market.",
          verdict: null,
          source: "ODDS_TERMINAL",
        },
      };
    }

    const plan = planned.plan as OddsTerminalReadPlan;
    const read = await readOddsTerminal(plan, {
      matchup: pick.matchup,
      subjectTeam: pick.subjectTeam,
    });
    if (!read) {
      return {
        ok: true,
        preview: {
          fetchedAt: new Date().toISOString(),
          ok: false,
          reason: pick.matchup
            ? `Odds Terminal is not listing a ${plan.league.toUpperCase()} game matching "${pick.matchup}" in the week ahead.`
            : "This row records no matchup, and Odds Terminal needs one to identify the game.",
          verdict: null,
          source: "ODDS_TERMINAL",
        },
      };
    }

    const body = await post({ ...pick, read });
    return { ok: true, preview: body.preview as OddsLookupResponse["preview"] };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof OddsTerminalSignedOutError
          ? error.message
          : error instanceof Error
            ? error.message
            : "the Odds Terminal read failed",
    };
  }
}

chrome.runtime.onMessage.addListener((message: CaptureMessage | { type: string }, sender, sendResponse) => {
  if (message?.type === "clv:odds-lookup") {
    (async () => {
      const pick = (message as OddsLookupMessage).pick;
      if (pick.source === "ODDS_TERMINAL") {
        sendResponse(await oddsTerminalLookup(pick));
        return;
      }
      try {
        const settings = await configured();
        if (!settings) {
          sendResponse({ ok: false, error: "not configured -- open the extension options" });
          return;
        }
        // The Odds API authenticates with its own key, held by the server -- there is no session
        // to push ahead of the request the way the banned PropProfessor path used to.
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

// A dashboard "warmer" also lived here: a one-line content script registered at runtime against
// the dashboard's own origin, whose only job was to tell this worker "the dashboard is open" so it
// could push a fresh PropProfessor screen token to the server before anyone clicked Odds. There is
// no token to push any more, so the script, its registration, the `clv:warm` message and the
// `scripting` permission it needed are all gone rather than left inert.
//
// // There used to be a second, `CLOSING_ALARM` alarm here that read PropProfessor's odds screen
// every minute -- both the scheduled closing-read queue and the Odds modal's on-demand queue rode
// on it. That automation is what got the PropProfessor account banned (2026-09). It is gone, and
// so is every module it drove: `closing-worker.ts`, `closing-reader.ts`, `odds-preview-worker.ts`
// and `pp-token.ts` have been deleted rather than left unreferenced, because an unreferenced
// reader is one import away from being a reader again. Closing-line capture stays paused; the Odds
// modal answers inside its own request from The Odds API or Odds Terminal.
//
// This alarm flushes the capture queue and does nothing else. It contacts no site but our own.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void flushQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue();
});
