import { marketFilterKey } from "@clv/shared";

/**
 * "Stop showing me these markets."
 *
 * Both boards surface markets that are never worth looking at -- a PrizePicks Fantasy Score, a
 * period-qualified "Receiving Yards - 1st Half", UFC significant strikes -- and they sit in the
 * middle of the list taking up the screen. Both boards already let you filter *to* a market; nobody
 * lets you filter one *away*, which is the shape the problem actually has: the exclusions are a
 * short, stable list, and the inclusions are everything else.
 *
 * Two deliberate properties:
 *
 *  - **The list is shared across boards**, keyed by `marketFilterKey`, so hiding "Receiving Yards"
 *    once hides PropProfessor's "Player Receiving Yards" too. It lives in `chrome.storage.sync`,
 *    so it follows the profile rather than the tab.
 *  - **Hiding is presentation only.** Nothing here touches capture, the parsers, or what the
 *    server is told. A hidden row is a row you did not want to read; if you reveal it and tick it,
 *    it is captured exactly as it always was.
 *
 * The site supplies the two halves this cannot know: what markets exist on its board, and how a row
 * is actually made to disappear (a `<td>`-per-row table and a virtualized AG Grid have nothing in
 * common here). See `MarketFilterHooks`.
 */

/** One market as the board currently offers it, with how many of its bets are on screen. */
export interface MarketOption {
  /** `marketFilterKey` output -- the identity the hide list is stored against. */
  key: string;
  /** The board's own spelling, shown in the list. */
  label: string;
  count: number;
}

export interface MarketFilterHooks {
  /**
   * Every market on the board right now. Counts must be taken *before* this filter is applied,
   * or a market would drop to zero the moment it was hidden and become impossible to find again.
   */
  vocabulary(): MarketOption[];
  /**
   * Hides every row whose market key is in `hidden`. `reveal` means the user has asked to see the
   * hidden rows anyway -- show them, ideally marked as hidden, but do not forget the list.
   *
   * Called on every injection pass, so it must be idempotent and cheap.
   */
  apply(hidden: ReadonlySet<string>, reveal: boolean): void;
  /**
   * Where the control mounts -- the board's own toolbar where there is one. Returning null just
   * defers: it is retried on the next pass, which is what SPA boards need.
   */
  toolbar(): HTMLElement | null;
}

/** What `chrome.storage.sync` holds. The label rides along so the chip list can name a market that
 *  is not on the board today (a hidden NBA market during football season, say). */
export interface HiddenMarket {
  key: string;
  label: string;
}

const STORAGE_KEY = "hiddenMarkets";

export const MARKET_FILTER_STYLES = `
.clva-mf { position: relative; display: inline-flex; align-items: center; gap: 6px; z-index: 30;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.clva-mf-pill {
  appearance: none; font: inherit; display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
  transition: border-color 120ms ease, color 120ms ease;
}
.clva-mf-pill:hover { border-color: var(--clva-accent); }
.clva-mf-pill svg { width: 13px; height: 13px; display: block; flex: 0 0 auto; }
.clva-mf-pill b {
  font-weight: 600; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  background: var(--clva-accent); color: #06110b;
}
.clva-mf-pill[data-open="1"] { border-color: var(--clva-accent); }
.clva-mf-reveal[data-on="1"] { border-color: var(--clva-accent); color: var(--clva-accent); }

.clva-mf-panel {
  position: fixed; z-index: 2147483002; width: min(340px, calc(100vw - 24px));
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 11px;
  box-shadow: 0 22px 55px rgba(0,0,0,0.65); overflow: hidden;
  display: flex; flex-direction: column; max-height: min(70vh, 520px);
}
/* The display rule above is a class selector, so it beats the user agent's own
   [hidden] { display: none } -- which meant setting the hidden property changed nothing and the
   panel could be opened but never closed. The property still carries the state; this applies it. */
.clva-mf-panel[hidden] { display: none !important; }
.clva-mf-panel header { padding: 13px 14px 0; }
.clva-mf-panel header h4 { margin: 0; font-size: 13px; font-weight: 600; }
.clva-mf-panel header p { margin: 3px 0 0; font-size: 11px; color: #8b9bb0; }
.clva-mf-search {
  font: inherit; margin: 11px 14px 0; padding: 7px 10px; border-radius: 8px;
  background: #0d141c; color: #e6edf6; border: 1px solid #243040; outline: none;
}
.clva-mf-search:focus { border-color: var(--clva-accent); }
.clva-mf-search::placeholder { color: #63748b; }

.clva-mf-list { overflow-y: auto; margin: 9px 0 0; padding: 0 6px 6px; flex: 1 1 auto; }
.clva-mf-row {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  font: inherit; padding: 7px 8px; border: 0; border-radius: 7px; cursor: pointer;
  background: transparent; color: #e6edf6;
}
.clva-mf-row:hover { background: #182231; }
.clva-mf-row span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clva-mf-row i { font-style: normal; font-size: 11px; color: #63748b; font-variant-numeric: tabular-nums; }
.clva-mf-row[data-hidden="1"] span { color: #8b9bb0; text-decoration: line-through; }
.clva-mf-row input { pointer-events: none; }
.clva-mf-group {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #63748b;
  padding: 9px 8px 4px; margin: 0;
}
.clva-mf-empty { color: #8b9bb0; font-size: 12px; padding: 14px 8px; margin: 0; text-align: center; }

.clva-mf-panel footer {
  display: flex; align-items: center; gap: 9px; padding: 10px 14px;
  border-top: 1px solid #1d2633; background: #101720;
}
.clva-mf-panel footer span { flex: 1 1 auto; font-size: 11px; color: #8b9bb0; }
.clva-mf-panel footer button {
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
}
.clva-mf-panel footer button:disabled { opacity: 0.45; cursor: default; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function eyeIcon(off: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  svg.append(path, circle);
  if (off) {
    const slash = document.createElementNS(ns, "path");
    slash.setAttribute("d", "M3 3l18 18");
    svg.appendChild(slash);
  }
  return svg;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

async function loadHidden(): Promise<HiddenMarket[]> {
  try {
    const stored = await chrome.storage.sync.get({ [STORAGE_KEY]: [] as HiddenMarket[] });
    const list = stored[STORAGE_KEY];
    if (!Array.isArray(list)) return [];
    // Re-derived rather than trusted: a key written by an older build (or hand-edited) must still
    // collapse onto whatever `marketFilterKey` means today.
    return list
      .filter((m): m is HiddenMarket => !!m && typeof m.key === "string" && m.key.length > 0)
      .map((m) => ({ key: marketFilterKey(m.key) || m.key, label: String(m.label ?? m.key) }));
  } catch {
    return [];
  }
}

/**
 * The control: a pill that opens a searchable market list, plus a reveal toggle that appears once
 * something is actually hidden.
 */
export function startMarketFilter(hooks: MarketFilterHooks): { refresh(): void } {
  let hidden: HiddenMarket[] = [];
  let hiddenKeys = new Set<string>();
  /** Deliberately not persisted: "let me look at what I hid" is a glance, not a preference. */
  let reveal = false;
  let query = "";

  const root = el("div", "clva-mf");
  const pill = el("button", "clva-mf-pill");
  pill.type = "button";
  const pillLabel = el("span", undefined, "Hide markets");
  const pillCount = el("b");
  pill.append(eyeIcon(true), pillLabel, pillCount);

  const revealBtn = el("button", "clva-mf-pill clva-mf-reveal");
  revealBtn.type = "button";
  const revealLabel = el("span");
  revealBtn.append(eyeIcon(false), revealLabel);

  root.append(pill, revealBtn);

  // --- panel ---------------------------------------------------------------
  const panel = el("div", "clva-mf-panel");
  panel.hidden = true;
  const head = el("header");
  head.append(el("h4", undefined, "Exclude markets"));
  const headSub = el("p");
  head.appendChild(headSub);
  const search = el("input", "clva-mf-search");
  search.type = "search";
  search.placeholder = "Search markets…";
  const list = el("div", "clva-mf-list");
  const foot = el("footer");
  const footText = el("span");
  const clearBtn = el("button", undefined, "Clear all");
  clearBtn.type = "button";
  foot.append(footText, clearBtn);
  panel.append(head, search, list, foot);

  function hiddenBetCount(vocab: MarketOption[]): number {
    let total = 0;
    for (const option of vocab) {
      if (hiddenKeys.has(option.key)) total += option.count;
    }
    return total;
  }

  /** Anchored to the pill on every open (and on scroll/resize while open), because both boards
   *  move their toolbars around and a once-positioned panel drifts away from its button. */
  function place(): void {
    const r = pill.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    const width = panel.offsetWidth || 340;
    panel.style.left = `${Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8))}px`;
  }

  function renderList(vocab: MarketOption[]): void {
    list.textContent = "";
    const byKey = new Map(vocab.map((o) => [o.key, o]));

    // Anything hidden but absent from today's board still belongs in the list -- otherwise the only
    // way to un-hide an out-of-season market would be to clear the whole list.
    const offBoard: MarketOption[] = hidden
      .filter((m) => !byKey.has(m.key))
      .map((m) => ({ key: m.key, label: m.label, count: 0 }));

    const needle = query.trim().toLowerCase();
    const matches = (o: MarketOption) => !needle || o.label.toLowerCase().includes(needle);

    const excluded = [...vocab, ...offBoard].filter((o) => hiddenKeys.has(o.key) && matches(o));
    const available = vocab.filter((o) => !hiddenKeys.has(o.key) && matches(o));
    // Busiest first: the markets worth hiding are the ones filling the board.
    available.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    excluded.sort((a, b) => a.label.localeCompare(b.label));

    const addGroup = (title: string, options: MarketOption[]) => {
      if (options.length === 0) return;
      list.appendChild(el("p", "clva-mf-group", title));
      for (const option of options) {
        const row = el("button", "clva-mf-row");
        row.type = "button";
        const isHidden = hiddenKeys.has(option.key);
        if (isHidden) row.dataset.hidden = "1";
        const box = el("input");
        box.type = "checkbox";
        box.className = "clva-box";
        box.checked = isHidden;
        box.tabIndex = -1;
        row.append(box, el("span", undefined, option.label));
        row.appendChild(el("i", undefined, option.count > 0 ? option.count.toLocaleString() : "—"));
        row.addEventListener("click", () => void toggle(option));
        list.appendChild(row);
      }
    };

    addGroup("Hidden", excluded);
    addGroup(needle ? "Matching" : "On this board", available);
    if (excluded.length === 0 && available.length === 0) {
      list.appendChild(
        el("p", "clva-mf-empty", needle ? `No market matches “${query.trim()}”.` : "No markets on the board yet.")
      );
    }
  }

  function render(): void {
    const vocab = hooks.vocabulary();
    const bets = hiddenBetCount(vocab);

    pillCount.textContent = hidden.length > 0 ? String(hidden.length) : "";
    pillCount.hidden = hidden.length === 0;
    pill.title =
      hidden.length === 0
        ? "Choose markets to hide from this board"
        : `${plural(hidden.length, "market", "markets")} hidden`;

    revealBtn.hidden = bets === 0;
    revealBtn.dataset.on = reveal ? "1" : "0";
    revealLabel.textContent = reveal ? `Showing ${plural(bets, "hidden bet", "hidden bets")}` : `${plural(bets, "bet", "bets")} hidden`;
    revealBtn.title = reveal ? "Hide them again" : "Show the hidden bets without clearing the list";

    headSub.textContent =
      bets > 0
        ? `${plural(bets, "bet", "bets")} hidden across ${plural(hidden.length, "market", "markets")}`
        : "Pick the markets you never want to see.";
    footText.textContent = reveal ? "Hidden bets are shown, dimmed." : `${plural(bets, "bet", "bets")} hidden`;
    clearBtn.disabled = hidden.length === 0;

    if (!panel.hidden) {
      renderList(vocab);
      place();
    }
    hooks.apply(hiddenKeys, reveal);
  }

  async function persist(): Promise<void> {
    hiddenKeys = new Set(hidden.map((m) => m.key));
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY]: hidden });
    } catch {
      // A full or unavailable sync store must not cost the user the filter they just set; it is
      // re-applied from memory either way and simply will not follow them to another machine.
    }
    render();
  }

  async function toggle(option: MarketOption): Promise<void> {
    hidden = hiddenKeys.has(option.key)
      ? hidden.filter((m) => m.key !== option.key)
      : [...hidden, { key: option.key, label: option.label }];
    // Revealing is about inspecting what is already hidden; a brand-new exclusion should be seen
    // to take effect, so the first one turns revealing back off.
    if (hidden.length === 0) reveal = false;
    await persist();
  }

  function openPanel(): void {
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.hidden = false;
    pill.dataset.open = "1";
    query = "";
    search.value = "";
    render();
    place();
    search.focus();
  }

  function closePanel(): void {
    panel.hidden = true;
    pill.dataset.open = "0";
  }

  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    if (panel.hidden) openPanel();
    else closePanel();
  });
  revealBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    reveal = !reveal;
    render();
  });
  clearBtn.addEventListener("click", () => {
    hidden = [];
    reveal = false;
    void persist();
  });
  search.addEventListener("input", () => {
    query = search.value;
    renderList(hooks.vocabulary());
  });
  // Capture phase on `window`, and containment tested against the actual target rather than left
  // to bubbling: both boards are React apps that stop propagation on their own clicks (AG Grid
  // handles every click on the grid itself), so a listener waiting for the event to bubble up to
  // `document` never hears about a click on the board -- which is most of the page.
  const onOutsidePointerDown = (event: Event) => {
    if (panel.hidden) return;
    const target = event.target;
    if (target instanceof Node && (panel.contains(target) || root.contains(target))) return;
    closePanel();
  };
  window.addEventListener("pointerdown", onOutsidePointerDown, true);
  // A board that handles pointer events without ever producing a click (or vice versa) still
  // closes the panel; `closePanel` is idempotent.
  window.addEventListener("click", onOutsidePointerDown, true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !panel.hidden) closePanel();
    },
    true
  );
  window.addEventListener("scroll", () => panel.hidden || place(), true);
  window.addEventListener("resize", () => panel.hidden || place());

  // Both boards rebuild their toolbars on navigation, so mounting is a repeated check rather than
  // a one-shot -- the same reason the checkbox column is re-injected rather than injected once.
  const keepMounted = () => {
    if (root.isConnected) return;
    const host = hooks.toolbar();
    if (host) host.appendChild(root);
  };

  void loadHidden().then((stored) => {
    hidden = stored;
    hiddenKeys = new Set(hidden.map((m) => m.key));
    render();
  });

  // Another tab (or the options page) changing the list must not leave this board stale.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[STORAGE_KEY]) return;
    void loadHidden().then((stored) => {
      hidden = stored;
      hiddenKeys = new Set(hidden.map((m) => m.key));
      render();
    });
  });

  keepMounted();
  setInterval(() => {
    keepMounted();
    render();
  }, 1000);

  // Re-applying is far cheaper than a full render, and it has to happen on the board's own
  // re-render cadence rather than this interval: a websocket odds tick rebuilds rows and takes the
  // hidden marking with them, and a second of the hidden rows flashing back is exactly the flicker
  // the filter exists to remove.
  return { refresh: () => hooks.apply(hiddenKeys, reveal) };
}
