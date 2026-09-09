import type { ParseResult, SiteId, SnapshotPayload } from "@clv/shared";
import type { CaptureMessage, CaptureResponse } from "./messages";
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
export const STYLE_ID = "clv-analyzer-styles";

const STYLES = `
:root { --clva-accent: ${DEFAULT_CHECKBOX_COLOR}; }
.clva-cell { text-align: center; vertical-align: middle; white-space: nowrap; }
.clva-head { color: var(--clva-accent) !important; font-weight: 700; letter-spacing: 0.04em; }
.clva-box {
  appearance: none; width: 16px; height: 16px; border-radius: 4px; cursor: pointer;
  border: 2px solid var(--clva-accent); background: transparent; position: relative;
  vertical-align: middle; flex: 0 0 auto; margin: 0 0.5px;
  transition: background 120ms ease, border-color 120ms ease;
}
.clva-box:hover { background: color-mix(in srgb, var(--clva-accent) 25%, transparent); }
.clva-box:checked { background: var(--clva-accent); }
.clva-box:checked::after {
  content: ""; position: absolute; left: 4px; top: 0px; width: 3px; height: 8px;
  border: solid #06110b; border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.clva-box[data-state="pending"] { border-color: #d29922; background: rgba(210,153,34,0.35); }
.clva-box[data-state="synced"] { border-color: var(--clva-accent); background: var(--clva-accent); }
.clva-box[data-state="error"] { border-color: #f85149; background: rgba(248,81,73,0.35); }
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

function setState(box: HTMLInputElement, state: "idle" | "pending" | "synced" | "error"): void {
  if (state === "idle") box.removeAttribute("data-state");
  else box.setAttribute("data-state", state);
}

async function capture(adapter: SiteAdapter, key: string | null, box: HTMLInputElement): Promise<void> {
  setState(box, "pending");

  const result = adapter.parse();
  if (!result.ok) {
    setState(box, "error");
    box.title = `CLV Analyzer: could not read the board (${result.reason ?? "unknown"})`;
    return;
  }

  // Rows are tied to their parsed counterpart by the site's own row id, not by position, so a
  // re-sort between injection and click cannot capture the wrong pick.
  const row = key ? (result.rows.find((r) => r.externalPropId === key) ?? null) : null;

  if (!row) {
    setState(box, "error");
    box.title = "CLV Analyzer: could not match this row in the parsed board";
    return;
  }
  if (!row.side || row.takenLine === null) {
    setState(box, "error");
    box.title = "CLV Analyzer: row is missing a side or line";
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
      box.title = response.queued
        ? "CLV Analyzer: server unreachable, queued and will retry"
        : `CLV Analyzer: captured (${response.status ?? "saved"})`;
    } else {
      setState(box, "error");
      box.title = `CLV Analyzer: ${response?.error ?? "capture failed"}`;
    }
  } catch (error) {
    setState(box, "error");
    box.title = `CLV Analyzer: ${error instanceof Error ? error.message : "capture failed"}`;
  }
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
        setState(box, "idle");
        return;
      }
      void capture(adapter, box.getAttribute(KEY_ATTR), box);
    });
    host.appendChild(box);
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
}
