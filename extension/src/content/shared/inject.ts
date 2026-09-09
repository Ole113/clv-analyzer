import type { ParseResult, ParsedRow, SiteId, SnapshotPayload } from "@clv/shared";
import { matchKeyForRow } from "@clv/shared";
import type {
  CaptureMessage,
  CaptureResponse,
  TrackedLookupResponse,
  UntrackResponse,
} from "./messages";
import { DEFAULT_CHECKBOX_COLOR, loadSettings } from "./config";

export interface SiteAdapter {
  site: SiteId;
  /** Which fantasy book the board is currently showing. */
  fantasyBook(): string;
  parse(): ParseResult;
  /** Element to watch for re-renders. */
  container(): Element | null;
  /** Logical rows plus the key that ties a row to its parsed counterpart. */
  rows(): { el: Element; key: string | null }[];
  /** Adds the column header once per render. Sites without a real header column can no-op. */
  injectHeader(): void;
  /** Returns the element the checkbox should live in for this row, creating it if needed. */
  mount(row: Element): HTMLElement | null;
  /** Extra CSS this site needs (e.g. reserving a column lane). Injected once. */
  extraStyles?: string;
}

const MARK = "data-clv-injected";
const KEY_ATTR = "data-clv-key";
const MATCH_ATTR = "data-clv-match";
export const STYLE_ID = "clv-analyzer-styles";

const STYLES = `
:root { --clva-accent: ${DEFAULT_CHECKBOX_COLOR}; }
.clva-cell { text-align: center; vertical-align: middle; white-space: nowrap; }
.clva-head { color: var(--clva-accent) !important; font-weight: 700; letter-spacing: 0.04em; }
.clva-box {
  appearance: none; width: 16px; height: 16px; border-radius: 4px; cursor: pointer;
  border: 2px solid var(--clva-accent); background: transparent; position: relative;
  vertical-align: middle; flex: 0 0 auto; margin: 0 3px;
  transition: background 120ms ease, border-color 120ms ease;
}
.clva-box:hover { background: color-mix(in srgb, var(--clva-accent) 25%, transparent); }
.clva-box:checked { background: var(--clva-accent); }
/* Centred by transform rather than hand-tuned offsets, so the tick stays centred at any box
   size and looks identical on both boards and in the options preview. The -55% vertical nudge
   accounts for the tick's own visual centre sitting below its bounding box. */
.clva-box:checked::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 3px; height: 8px; box-sizing: border-box;
  border: solid #06110b; border-width: 0 2px 2px 0;
  transform: translate(-50%, -55%) rotate(45deg);
}
.clva-box[data-state="pending"] { border-color: #d29922; background: rgba(210,153,34,0.35); }
.clva-box[data-state="synced"] { border-color: var(--clva-accent); background: var(--clva-accent); }
.clva-box[data-state="error"] { border-color: #f85149; background: rgba(248,81,73,0.35); }

/* --- toasts ---------------------------------------------------------------
   A red checkbox with a title attribute is easy to miss and impossible to read on a dense board,
   so every outcome that is not a plain success says so in the corner as well. */
.clva-toasts {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; flex-direction: column; gap: 8px; max-width: 380px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: none;
}
.clva-toast {
  pointer-events: auto; display: flex; gap: 9px; align-items: flex-start;
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-left-width: 3px;
  border-radius: 9px; padding: 10px 11px; box-shadow: 0 10px 28px rgba(0,0,0,0.55);
}
.clva-toast b { font-weight: 600; display: block; }
.clva-toast span { color: #8b9bb0; font-size: 12px; display: block; margin-top: 2px; }
.clva-toast-success { border-left-color: #3fb950; }
.clva-toast-error { border-left-color: #f85149; }
.clva-toast-info { border-left-color: #4c9aff; }
.clva-toast button {
  margin-left: auto; background: none; border: 0; color: #8b9bb0; cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 2px;
}

/* --- confirm dialog --- */
.clva-scrim {
  position: fixed; inset: 0; z-index: 2147483001; background: rgba(4,7,11,0.6);
  display: flex; align-items: center; justify-content: center;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.clva-modal {
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 11px;
  padding: 18px 20px; width: min(420px, calc(100vw - 40px));
  box-shadow: 0 22px 55px rgba(0,0,0,0.65);
}
.clva-modal h3 { margin: 0 0 8px; font-size: 15px; }
.clva-modal p { margin: 0; color: #8b9bb0; }
.clva-modal .clva-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
.clva-modal button {
  font: inherit; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
}
.clva-modal button.clva-danger { border-color: rgba(248,81,73,0.5); color: #ff9b95; }
`;

function ensureStyles(extra?: string): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES + (extra ?? "");
  document.documentElement.appendChild(style);
}

/** The checkbox colour is a setting, so it is applied as a variable and can change live. */
function applyAccent(color: string | undefined): void {
  document.documentElement.style.setProperty(
    "--clva-accent",
    color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : DEFAULT_CHECKBOX_COLOR
  );
}

function toastHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>(".clva-toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "clva-toasts";
    document.body.appendChild(host);
  }
  return host;
}

function toast(tone: "success" | "error" | "info", message: string, detail?: string | null): void {
  const el = document.createElement("div");
  el.className = `clva-toast clva-toast-${tone}`;
  const body = document.createElement("div");
  const title = document.createElement("b");
  title.textContent = message;
  body.appendChild(title);
  if (detail) {
    const sub = document.createElement("span");
    sub.textContent = detail;
    body.appendChild(sub);
  }
  el.appendChild(body);

  const close = document.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => el.remove());
  el.appendChild(close);

  toastHost().appendChild(el);
  // Errors stay put: an error that vanished before it was read is the problem being fixed here.
  if (tone !== "error") setTimeout(() => el.remove(), 5000);
}

/** An in-page confirmation, so unticking a pick cannot silently delete it on a stray click. */
function confirmDialog(title: string, body: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "clva-scrim";
    const modal = document.createElement("div");
    modal.className = "clva-modal";
    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = body;
    const actions = document.createElement("div");
    actions.className = "clva-actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Keep it";
    const ok = document.createElement("button");
    ok.className = "clva-danger";
    ok.textContent = confirmLabel;

    const done = (value: boolean) => {
      scrim.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
    };

    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done(false);
    });
    document.addEventListener("keydown", onKey, true);

    actions.append(cancel, ok);
    modal.append(h, p, actions);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    ok.focus();
  });
}

function setState(box: HTMLInputElement, state: "idle" | "pending" | "synced" | "error"): void {
  if (state === "idle") box.removeAttribute("data-state");
  else box.setAttribute("data-state", state);
}

function fail(box: HTMLInputElement, message: string, detail?: string | null): void {
  setState(box, "error");
  box.checked = false;
  box.title = `CLV Analyzer: ${message}${detail ? ` — ${detail}` : ""}`;
  toast("error", message, detail);
}

async function capture(adapter: SiteAdapter, key: string | null, box: HTMLInputElement): Promise<void> {
  setState(box, "pending");

  const result = adapter.parse();
  if (!result.ok) {
    fail(box, "Could not read the board", result.reason ?? "unknown reason");
    return;
  }

  // Rows are tied to their parsed counterpart by the site's own row id, not by position, so a
  // re-sort between injection and click cannot capture the wrong pick.
  const row = key ? (result.rows.find((r) => r.externalPropId === key) ?? null) : null;

  if (!row) {
    fail(box, "Could not find this row on the board", "It may have moved or been re-sorted; try again.");
    return;
  }
  if (row.takenLine === null) {
    fail(
      box,
      "This bet has no line to track",
      "Moneylines and other markets without a number cannot be measured for closing line value."
    );
    return;
  }
  if (row.marketType === "PLAYER_PROP" && (!row.player || !row.side)) {
    fail(box, "This row is missing a player or side", "The board may have changed layout.");
    return;
  }
  if (row.marketType === "SPREAD" && !row.subjectTeam) {
    fail(box, "This spread has no team attached", "The board may have changed layout.");
    return;
  }

  const payload: SnapshotPayload = {
    site: adapter.site,
    fantasyBook: adapter.fantasyBook(),
    pageUrl: location.href,
    capturedAt: new Date().toISOString(),
    sourceDevice: null,
    row,
    rawHtml: "",
  };

  const message: CaptureMessage = { type: "clv:capture", payload };
  try {
    const response: CaptureResponse = await chrome.runtime.sendMessage(message);
    if (response?.ok) {
      setState(box, "synced");
      box.setAttribute(MATCH_ATTR, matchKeyForRow(adapter.site, adapter.fantasyBook(), row));
      if (response.queued) {
        box.title = "CLV Analyzer: server unreachable, queued and will retry";
        toast("info", "Queued — the server was unreachable", "It will be sent automatically once the server is reachable again.");
      } else {
        box.title = `CLV Analyzer: captured (${response.status ?? "saved"})`;
        toast(
          "success",
          row.isLive ? "Live pick captured" : "Pick captured",
          row.isLive ? "Live picks record EV% but get no closing-line verdict." : null
        );
      }
    } else {
      fail(box, "Could not save this pick", response?.error ?? "capture failed");
    }
  } catch (error) {
    fail(box, "Could not save this pick", error instanceof Error ? error.message : "capture failed");
  }
}

/** Removes a pick after the user unticks it, once they confirm they meant to. */
async function untrack(box: HTMLInputElement, label: string): Promise<void> {
  const matchKey = box.getAttribute(MATCH_ATTR);
  if (!matchKey) {
    // Nothing was ever stored for this row, so unticking is purely local.
    setState(box, "idle");
    return;
  }

  const confirmed = await confirmDialog(
    "Remove this pick?",
    `${label} will be deleted from the analyzer, along with the snapshot taken when you ticked it. Picks whose closing line has already been recorded are kept.`,
    "Remove it"
  );
  if (!confirmed) {
    // Put it back exactly as it was: the user said no.
    box.checked = true;
    setState(box, "synced");
    return;
  }

  setState(box, "pending");
  try {
    const response: UntrackResponse = await chrome.runtime.sendMessage({
      type: "clv:untrack",
      matchKey,
    });
    if (response?.ok) {
      box.removeAttribute(MATCH_ATTR);
      setState(box, "idle");
      box.title = "Track this pick for CLV";
      toast("success", "Pick removed");
    } else {
      box.checked = true;
      setState(box, "synced");
      toast("error", "Could not remove this pick", response?.error ?? "unknown error");
    }
  } catch (error) {
    box.checked = true;
    setState(box, "synced");
    toast("error", "Could not remove this pick", error instanceof Error ? error.message : null);
  }
}

function labelFor(row: ParsedRow | null): string {
  if (!row) return "This pick";
  if (row.selectionName) return row.selectionName;
  if (row.player) return `${row.player} ${row.side === "OVER" ? "Over" : "Under"} ${row.takenLine}`;
  return `${row.statMarket ?? "This market"} ${row.takenLine ?? ""}`.trim();
}

function injectRows(adapter: SiteAdapter): void {
  for (const { el, key } of adapter.rows()) {
    const host = adapter.mount(el);
    if (!host) continue;
    if (host.querySelector(`[${MARK}]`)) {
      // Row survived a re-render; keep the checkbox but refresh the key in case rows shifted.
      const existing = host.querySelector<HTMLInputElement>(`[${MARK}]`);
      if (existing && key) existing.setAttribute(KEY_ATTR, key);
      continue;
    }

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "clva-box";
    box.setAttribute(MARK, "1");
    if (key) box.setAttribute(KEY_ATTR, key);
    box.title = "Track this pick for CLV";
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => {
      if (!box.checked) {
        const rowKey = box.getAttribute(KEY_ATTR);
        const parsed = adapter.parse();
        const row = rowKey ? (parsed.rows.find((r) => r.externalPropId === rowKey) ?? null) : null;
        void untrack(box, labelFor(row));
        return;
      }
      void capture(adapter, box.getAttribute(KEY_ATTR), box);
    });
    host.appendChild(box);
  }
}

/**
 * Restores ticks from the server.
 *
 * Without this a tick lived only in the DOM, so a refresh (or the board re-rendering on a websocket
 * odds tick) silently cleared it while the pick stayed in the database -- the checkbox and the
 * analyzer disagreed. The server is the source of truth; the board is redrawn from it.
 */
async function syncTracked(adapter: SiteAdapter): Promise<void> {
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(`[${MARK}]`));
  if (boxes.length === 0) return;

  const parsed = adapter.parse();
  if (!parsed.ok) return;

  const book = adapter.fantasyBook();
  const byPropId = new Map<string, ParsedRow>();
  for (const row of parsed.rows) {
    if (row.externalPropId) byPropId.set(row.externalPropId, row);
  }

  const keyByBox = new Map<HTMLInputElement, string>();
  for (const box of boxes) {
    const rowKey = box.getAttribute(KEY_ATTR);
    const row = rowKey ? byPropId.get(rowKey) : undefined;
    if (!row || row.takenLine === null) continue;
    keyByBox.set(box, matchKeyForRow(adapter.site, book, row));
  }
  if (keyByBox.size === 0) return;

  let response: TrackedLookupResponse;
  try {
    response = await chrome.runtime.sendMessage({
      type: "clv:tracked",
      matchKeys: [...new Set(keyByBox.values())],
    });
  } catch {
    return; // offline or the worker is asleep; the next pass tries again
  }
  if (!response?.ok || !response.tracked) return;

  const tracked = new Set(response.tracked);
  for (const [box, matchKey] of keyByBox) {
    const isTracked = tracked.has(matchKey);
    // Never fight a click that is still in flight.
    if (box.getAttribute("data-state") === "pending") continue;
    if (isTracked) {
      box.setAttribute(MATCH_ATTR, matchKey);
      if (!box.checked) {
        box.checked = true;
        setState(box, "synced");
        box.title = "Tracked — untick to remove this pick from the analyzer";
      }
    } else if (box.checked && box.getAttribute("data-state") === "synced") {
      // The pick is gone server-side (deleted from the dashboard), so stop showing it as tracked.
      box.checked = false;
      box.removeAttribute(MATCH_ATTR);
      setState(box, "idle");
    }
  }
}

/**
 * Keeps the column present. Both boards are client-rendered and rebuild rows on sort, filter and
 * every websocket odds tick, so injection has to be idempotent and repeated rather than one-shot.
 */
export function startCapture(adapter: SiteAdapter): void {
  ensureStyles(adapter.extraStyles);

  void loadSettings().then((settings) => applyAccent(settings.checkboxColor));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.checkboxColor) applyAccent(changes.checkboxColor.newValue);
  });

  let queued = false;
  const run = () => {
    queued = false;
    try {
      adapter.injectHeader();
      injectRows(adapter);
    } catch (error) {
      console.warn("[CLV Analyzer] injection failed:", error);
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(run, 250);
  };

  run();

  const observer = new MutationObserver(schedule);
  const target = adapter.container() ?? document.body;
  observer.observe(target, { childList: true, subtree: true });

  // The grids sometimes swap their whole container out; a slow interval is a cheap safety net.
  setInterval(schedule, 4000);

  // Restoring ticks needs a round trip, so it runs on its own slower cadence rather than on every
  // re-render. The first pass is delayed to let the board finish its initial load.
  setTimeout(() => void syncTracked(adapter), 2500);
  setInterval(() => void syncTracked(adapter), 15000);
}
