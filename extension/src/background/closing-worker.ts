import {
  parseOddsJamTable,
  parsePropProfessorTable,
  findMatchingRow,
  type ParsedRow,
  type ParseResult,
  type PickSide,
} from "@clv/shared";
import { apiUrl, loadSettings } from "../content/shared/config";

/**
 * Reads closing boards in the user's own logged-in Chrome.
 *
 * The boards sit behind Cloudflare and a paid login, so an automated browser cannot load them --
 * but this browser already can, because the user is signed in and has passed the bot check
 * normally. The server decides *when* each pick is due; this worker does the reading.
 *
 * Consequence worth knowing: Chrome has to be running near kickoff. If it is not, the pick stays
 * queued and is read whenever Chrome next comes online -- and the server flags that read as late
 * rather than passing it off as a genuine close.
 */

export interface WorkItem {
  id: string;
  site: "ODDSJAM" | "PROPPROFESSOR";
  fantasyBook: string;
  player: string;
  statMarket: string;
  side: PickSide;
  externalPropId: string | null;
  pageUrl: string | null;
  gameStartTime: string | null;
}

const BOARD_URL: Record<WorkItem["site"], (book: string) => string> = {
  ODDSJAM: (book) => `https://fantasy.oddsjam.com/fantasy-odds/${book && book !== "unknown" ? book : "prizepicks"}`,
  PROPPROFESSOR: () => "https://www.propprofessor.com/fantasy",
};

const MAX_SCROLL_PASSES = 12;
const LOAD_TIMEOUT_MS = 60_000;
/** The boards arrive over a websocket well after document load, so rows need their own wait. */
const BOARD_READY_TIMEOUT_MS = 45_000;

function boardUrlFor(item: WorkItem): string {
  const url = item.pageUrl && /^https?:\/\//.test(item.pageUrl) ? item.pageUrl : null;
  return url ?? BOARD_URL[item.site](item.fantasyBook);
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timed out loading the board"));
    }, LOAD_TIMEOUT_MS);

    const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scrolls whichever container the site actually virtualizes: AG Grid's viewport or the window. */
function scrollBoard(): boolean {
  const vp = document.querySelector<HTMLElement>(".ag-body-viewport");
  if (vp) {
    vp.scrollTop += 900;
    return true;
  }
  window.scrollBy(0, 900);
  return true;
}

/** Detects the Cloudflare interstitial, which renders instead of the board and has no table. */
function detectChallenge(): boolean {
  const text = (document.body?.innerText ?? "").toLowerCase();
  return (
    !!document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile, iframe[src*='challenges.cloudflare.com']") ||
    /verify you are human|just a moment|performing security verification|checking your browser/.test(text)
  );
}

async function isChallenged(tabId: number): Promise<boolean> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: detectChallenge });
    return res?.result === true;
  } catch {
    return false;
  }
}

/**
 * Prefers a tab already sitting on the same board: it is warmed, already past any bot check, and
 * reading it disturbs nothing. Only falls back to opening a background tab when none exists.
 */
async function findOrOpenTab(url: string): Promise<{ tabId: number; opened: boolean }> {
  const target = new URL(url);
  const existing = await chrome.tabs.query({ url: `${target.origin}${target.pathname}*` });
  const usable = existing.find((t) => t.id !== undefined && t.status !== "unloaded");
  if (usable?.id !== undefined) return { tabId: usable.id, opened: false };

  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error("could not open a tab for the board");
  await waitForTabLoad(tab.id);
  return { tabId: tab.id, opened: true };
}

async function parseBoard(tabId: number, site: WorkItem["site"]): Promise<ParseResult> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: site === "ODDSJAM" ? parseOddsJamTable : parsePropProfessorTable,
  });
  return (injection?.result as ParseResult) ?? { ok: false, reason: "no result", headers: [], rows: [] };
}

export interface BoardReadResult {
  row: ParsedRow | null;
  parseOk: boolean;
  boardRowCount: number;
  reason: string | null;
}

/**
 * Opens the board in a background tab, scrolls until the prop shows up (both grids only render
 * what is on screen), and returns the matching row.
 */
export async function readClosingBoard(item: WorkItem): Promise<BoardReadResult> {
  const url = boardUrlFor(item);
  let tabId: number | null = null;
  let opened = false;

  try {
    const tab = await findOrOpenTab(url);
    tabId = tab.tabId;
    opened = tab.opened;

    // Wait for real rows rather than a fixed sleep: document load fires long before the websocket
    // has filled the grid, and an empty board previously looked identical to a missing one.
    const deadline = Date.now() + BOARD_READY_TIMEOUT_MS;
    let ready: ParseResult | null = null;
    while (Date.now() < deadline) {
      const result = await parseBoard(tabId, item.site);
      if (result.ok && result.rows.length > 0) {
        ready = result;
        break;
      }
      if (await isChallenged(tabId)) {
        return {
          row: null,
          parseOk: false,
          boardRowCount: 0,
          reason:
            `Cloudflare check is blocking the board. Open ${url} in a normal tab, clear the ` +
            `"Verify you are human" step, then queue this read again.`,
        };
      }
      await sleep(1500);
    }

    if (!ready) {
      return {
        row: null,
        parseOk: false,
        boardRowCount: 0,
        reason: `Board never rendered any rows within ${BOARD_READY_TIMEOUT_MS / 1000}s (still loading, signed out, or the page layout changed).`,
      };
    }

    const seen = new Map<string, ParsedRow>();
    const absorb = (result: ParseResult) => {
      for (const row of result.rows) {
        const key =
          row.externalPropId ?? `${row.player}|${row.statMarket}|${row.side}|${row.rowIndex}`;
        if (!seen.has(key)) seen.set(key, row);
      }
    };
    absorb(ready);

    const target = {
      player: item.player,
      statMarket: item.statMarket,
      side: item.side,
      externalPropId: item.externalPropId,
    };

    let match = findMatchingRow([...seen.values()], target);
    for (let pass = 0; pass < MAX_SCROLL_PASSES && !match; pass++) {
      const before = seen.size;
      await chrome.scripting.executeScript({ target: { tabId }, func: scrollBoard });
      await sleep(900);
      absorb(await parseBoard(tabId, item.site));
      match = findMatchingRow([...seen.values()], target);
      // Only stop once the board has actually produced rows and stopped producing more.
      if (!match && seen.size === before && seen.size > 0 && pass > 0) break;
    }

    return {
      row: match,
      parseOk: true,
      boardRowCount: seen.size,
      reason: match ? null : `Prop not found among ${seen.size} rows on the board`,
    };
  } catch (error) {
    return {
      row: null,
      parseOk: false,
      boardRowCount: 0,
      reason: error instanceof Error ? error.message : "board read failed",
    };
  } finally {
    // Never close a tab the user already had open.
    if (tabId !== null && opened) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

/** Asks the server what is due, reads each board, and reports back. Returns how many it handled. */
export async function runClosingWork(): Promise<number> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) return 0;

  let work: WorkItem[] = [];
  try {
    const response = await fetch(apiUrl(settings.backendUrl, "/api/closing-work"), {
      headers: { "x-api-key": settings.apiKey },
    });
    if (!response.ok) return 0;
    const body = (await response.json()) as { work?: WorkItem[] };
    work = body.work ?? [];
  } catch {
    return 0; // server unreachable; try again on the next alarm
  }

  let handled = 0;
  // One tab at a time: this runs in the background while the user is working.
  for (const item of work) {
    const read = await readClosingBoard(item);
    try {
      await fetch(apiUrl(settings.backendUrl, "/api/closing-snapshots"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
        body: JSON.stringify({
          betId: item.id,
          row: read.row,
          parseOk: read.parseOk,
          boardRowCount: read.boardRowCount,
          reason: read.reason,
        }),
      });
      handled++;
    } catch {
      // Leave it due; the server will hand it back on the next poll.
    }
  }
  return handled;
}
