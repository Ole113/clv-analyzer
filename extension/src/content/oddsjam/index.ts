import { parseOddsJamTable } from "@clv/shared";
import { startCapture, type SiteAdapter } from "../shared/inject";

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
