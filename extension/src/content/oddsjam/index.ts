import { marketFilterKey, parseOddsJamTable } from "@clv/shared";
import { startCapture, type SiteAdapter } from "../shared/inject";
import type { MarketOption } from "../shared/market-filter";

/**
 * OddsJam renders a plain <table>, so the tracker really is an extra column: a <th> in the header
 * and a <td> per row, inserted first.
 *
 * It is deliberately separate from OddsJam's own "TRACK" checkbox (which opens their bet-slip /
 * parlay builder). This adapter never reads or clicks that column -- it only touches nodes it
 * created itself.
 */
const HEAD_MARK = "data-clv-head";

/**
 * The optimizer table, on either layout.
 *
 * The player-prop boards head their columns PLAYER / STAT. The rebet and fliff boards are whole
 * game markets instead and head theirs Game / Market / Bet Name, so probing only for PLAYER+STAT
 * found nothing there and the column was never injected.
 */
function table(): HTMLTableElement | null {
  const tables = Array.from(document.querySelectorAll("table"));
  return (
    tables.find((t) => {
      const header = t.querySelector("thead tr");
      const text = (header?.textContent ?? "").toUpperCase();
      if (text.includes("PLAYER") && text.includes("STAT")) return true;
      return text.includes("BET NAME") && text.includes("MARKET");
    }) ?? null
  );
}

/**
 * Which column names the market, on either layout: STAT on the player-prop boards, MARKET on the
 * rebet/fliff game-market ones. Resolved per call rather than cached because the board swaps
 * layouts without a reload when the fantasy book changes.
 */
function marketColumnIndex(t: HTMLTableElement): number {
  // The tracker's own header cell is excluded here and its <td> is excluded in `marketOf`, so the
  // index means the same thing in both regardless of whether this pass happens to fall between
  // the header being injected and the rows being injected.
  const headers = Array.from(t.querySelectorAll("thead tr th:not(.clva-cell)")).map((h) =>
    ((h as HTMLElement).innerText ?? h.textContent ?? "").toUpperCase()
  );
  const stat = headers.findIndex((h) => h.includes("STAT"));
  if (stat >= 0) return stat;
  return headers.findIndex((h) => h.trim() === "MARKET");
}

/**
 * The market a row is quoting, read straight off its cell.
 *
 * Deliberately not `parseOddsJamTable()`, even though that already knows: the full parse walks
 * every book column of every row to build `BookLine`s nothing here looks at, and this runs on the
 * board's own re-render cadence. Reading one cell is the difference between a filter that keeps up
 * with a websocket tick and one that visibly lags it.
 */
function marketOf(row: Element, columnIndex: number): { key: string; label: string } | null {
  if (columnIndex < 0) return null;
  const cell = row.querySelectorAll(":scope > td:not(.clva-cell)")[columnIndex];
  if (!cell) return null;
  // Multi-line cells (the game boards stack market over bet name) name the market on line one.
  const label = ((cell as HTMLElement).innerText ?? cell.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!label) return null;
  const key = marketFilterKey(label);
  return key ? { key, label } : null;
}

const HIDDEN_ATTR = "data-clv-hidden";

/**
 * Hiding is a marked attribute plus a stylesheet rule rather than an inline `display: none`, so
 * that revealing restores whatever display value OddsJam's own CSS gave the row instead of a value
 * guessed here -- and so a re-render that drops our attribute cannot leave a row stuck invisible.
 */
const FILTER_STYLES = `
tr[${HIDDEN_ATTR}] { display: none !important; }
html.clva-reveal tr[${HIDDEN_ATTR}] { display: revert !important; opacity: 0.45; }
/* Beside OddsJam's own "Reset Filters" button, as a sibling of that button's group rather than a
   member of it -- dropping it inside the group inherits the group's own button spacing and
   wrapping rules and makes it read as one of OddsJam's controls. */
.clva-filter-inline {
  display: inline-flex; align-items: center; gap: 8px; margin-left: 10px;
  vertical-align: middle; flex: 0 0 auto;
}
/* Fallback bar, used only when the Reset Filters button cannot be found. */
.clva-filter-bar {
  display: flex; justify-content: flex-end; align-items: center; gap: 8px;
  padding: 8px 4px; box-sizing: border-box;
}
`;

const BAR_CLASS = "clva-filter-bar";
const INLINE_CLASS = "clva-filter-inline";

/** OddsJam's own "Reset Filters" control, whatever element it happens to be rendered as. */
function resetFiltersButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a')
  );
  return (
    candidates.find((el) => /^reset\s+filters$/i.test((el.textContent ?? "").trim())) ?? null
  );
}

/**
 * Where the control goes: immediately to the right of OddsJam's "Reset Filters" button, inserted
 * after the group that button belongs to rather than into it.
 *
 * The fallback -- its own bar above the table -- is kept for the boards (or future layouts) with no
 * Reset Filters control at all. It deliberately goes outside whatever horizontally scrolling
 * wrapper holds the table, since inside it the control would slide off-screen as soon as the board
 * was scrolled sideways to reach a sportsbook column.
 */
function filterBar(): HTMLElement | null {
  const existing = document.querySelector<HTMLElement>(`.${INLINE_CLASS}, .${BAR_CLASS}`);
  if (existing?.isConnected) return existing;

  const reset = resetFiltersButton();
  const group = reset?.parentElement;
  if (group?.parentElement) {
    const host = document.createElement("div");
    host.className = INLINE_CLASS;
    // After the whole group, so the control sits beside OddsJam's buttons without joining them.
    group.parentElement.insertBefore(host, group.nextSibling);
    return host;
  }

  const t = table();
  if (!t) return null;
  let anchorEl: Element = t;
  for (let node = t.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") anchorEl = node;
  }
  if (!anchorEl.parentElement) return null;

  const bar = document.createElement("div");
  bar.className = BAR_CLASS;
  anchorEl.parentElement.insertBefore(bar, anchorEl);
  return bar;
}

const adapter: SiteAdapter = {
  site: "ODDSJAM",

  // The cell here is a real <td> with the row's full height, so the odds button stacks above the
  // checkbox without widening the column. See `SiteAdapter.oddsButton`.
  oddsButton: true,

  fantasyBook() {
    const match = location.pathname.match(/\/fantasy-odds\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "unknown";
  },

  parse: parseOddsJamTable,

  container() {
    return table();
  },

  rows() {
    const t = table();
    if (!t) return [];
    return Array.from(t.querySelectorAll("tbody tr")).map((el) => {
      const raw = el.getAttribute("id");
      let key: string | null = null;
      if (raw) {
        try {
          key = decodeURIComponent(raw);
        } catch {
          key = raw;
        }
      }
      return { el, key };
    });
  },

  injectHeader() {
    const headerRow = table()?.querySelector("thead tr");
    if (!headerRow || headerRow.querySelector(`[${HEAD_MARK}]`)) return;
    const th = document.createElement("th");
    th.setAttribute(HEAD_MARK, "1");
    th.className = "clva-cell clva-head";
    // Deliberately blank: the column needs a header cell to keep the table's columns aligned,
    // but a label there just competes with OddsJam's own headers.
    th.textContent = "";
    headerRow.insertBefore(th, headerRow.firstChild);
  },

  extraStyles: FILTER_STYLES,

  marketFilter: {
    vocabulary() {
      const t = table();
      if (!t) return [];
      const columnIndex = marketColumnIndex(t);
      const byKey = new Map<string, MarketOption>();
      for (const row of Array.from(t.querySelectorAll("tbody tr"))) {
        const market = marketOf(row, columnIndex);
        if (!market) continue;
        const found = byKey.get(market.key);
        if (found) found.count += 1;
        else byKey.set(market.key, { key: market.key, label: market.label, count: 1 });
      }
      return [...byKey.values()];
    },

    apply(hidden, reveal) {
      document.documentElement.classList.toggle("clva-reveal", reveal && hidden.size > 0);
      const t = table();
      if (!t) return;
      const columnIndex = marketColumnIndex(t);
      for (const row of Array.from(t.querySelectorAll("tbody tr"))) {
        const market = hidden.size > 0 ? marketOf(row, columnIndex) : null;
        if (market && hidden.has(market.key)) row.setAttribute(HIDDEN_ATTR, "1");
        else row.removeAttribute(HIDDEN_ATTR);
      }
    },

    toolbar: filterBar,
  },

  mount(row) {
    let cell = row.querySelector<HTMLTableCellElement>("td.clva-cell");
    if (!cell) {
      cell = document.createElement("td");
      cell.className = "clva-cell";
      row.insertBefore(cell, row.firstChild);
    }
    return cell;
  },
};

startCapture(adapter);
