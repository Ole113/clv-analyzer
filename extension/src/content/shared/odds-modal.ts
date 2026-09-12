import type { ParsedRow } from "@clv/shared";
import type { OddsLookupLine, OddsLookupMessage, OddsLookupPick, OddsLookupResponse } from "./messages";

/**
 * "What is this market priced at right now", shown on the board itself.
 *
 * The dashboard has had this for a while (`server/src/components/odds-preview-modal.tsx`), but the
 * dashboard is the wrong place to ask the question: by the time a pick is on `/bets` it has already
 * been taken. The decision happens on the board, looking at a row, and until now the only way to
 * check the real sportsbook market behind a DFS line was to open PropProfessor's odds screen in
 * another tab and search for the player by hand.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not compute anything.** The averaging, the sportsbook allowlist and the outlier test
 *    stay in `buildClosingVerdict` on the server, reached through `/api/odds-lookup`. A second
 *    implementation here would drift, and the failure mode of that is two screens quoting different
 *    closing numbers for the same market with no way to tell which is right.
 *  - **It does not read the board it is opened from.** The row's identity comes from the adapter's
 *    own parse (already done for capture); the numbers always come from PropProfessor, whichever
 *    board asked. An OddsJam row asking about its market sends nothing to OddsJam.
 */

export const ODDS_MODAL_STYLES = `
.clva-odds-btn {
  appearance: none; width: 16px; height: 16px; padding: 0; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(139,155,176,0.5); border-radius: 4px; background: transparent;
  color: #8b9bb0; cursor: pointer; line-height: 0;
  transition: color 120ms ease, border-color 120ms ease;
}
.clva-odds-btn:hover { color: var(--clva-accent); border-color: var(--clva-accent); }
.clva-odds-btn svg { width: 10px; height: 10px; display: block; }
/* Stacked, never side by side: the column these live in is a fixed 24px lane on one board and a
   hand-inserted <td> on the other, and widening either is what causes the layout complaints this
   project already has. Vertically there is row height to spare -- which is why the gap is 9px and
   not the 4px it started at: at 4px the odds button and the checkbox read as one control and were
   easy to mis-click, and the row is tall enough that the extra 5px costs nothing. */
.clva-stack { display: flex; flex-direction: column; align-items: center; gap: 9px; }

.clva-odds-modal {
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 11px;
  padding: 18px 20px; width: min(620px, calc(100vw - 40px));
  max-height: min(80vh, 720px); overflow-y: auto;
  box-shadow: 0 22px 55px rgba(0,0,0,0.65);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.clva-odds-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
.clva-odds-head h3 { margin: 0; font-size: 15px; }
.clva-odds-head .clva-sub { color: #8b9bb0; font-size: 12px; margin-top: 2px; }
.clva-odds-head-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.clva-odds-modal button {
  font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
}
.clva-odds-modal button:disabled { opacity: 0.55; cursor: default; }

.clva-odds-summary {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; margin: 14px 0 10px;
}
.clva-odds-stat { display: inline-flex; align-items: baseline; gap: 6px; }
.clva-odds-stat i {
  font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  color: #8b9bb0;
}
.clva-odds-stat b { font-size: 14px; font-weight: 600; }
.clva-odds-stat s { text-decoration: none; color: #8b9bb0; font-size: 11px; }
.clva-good { color: #3fb950; }
.clva-bad { color: #f85149; }

.clva-odds-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.clva-odds-table th, .clva-odds-table td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid #1d2633; font-size: 12px;
}
.clva-odds-table th { color: #8b9bb0; font-weight: 500; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.06em; }
.clva-odds-table td.clva-num, .clva-odds-table th.clva-num { text-align: right; font-variant-numeric: tabular-nums; }
.clva-odds-table tr.clva-excluded td { opacity: 0.5; }
.clva-odds-book { display: inline-flex; align-items: center; gap: 7px; }
.clva-odds-book img { width: 15px; height: 15px; border-radius: 3px; object-fit: contain; }
.clva-odds-note { color: #8b9bb0; font-size: 11px; margin: 12px 0 0; }
.clva-odds-msg { color: #ff9b95; margin: 18px 0; }
.clva-odds-wait { color: #8b9bb0; margin: 24px 0; text-align: center; }
`;

/** American odds the way a book writes them. */
function fmtOdds(price: number | null): string {
  if (price === null) return "--";
  return price > 0 ? `+${price}` : `${price}`;
}

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

/** The identity the server needs to find this market, taken from the board's own parse. */
export function pickFromRow(row: ParsedRow): OddsLookupPick {
  return {
    sport: row.sport,
    statMarket: row.statMarket ?? "",
    marketType: row.marketType,
    player: row.player,
    subjectTeam: row.subjectTeam,
    matchup: row.matchup,
    side: row.side,
    takenLine: row.takenLine,
    externalPropId: row.externalPropId,
  };
}

function summary(verdict: NonNullable<NonNullable<OddsLookupResponse["preview"]>["verdict"]>, fetchedAt: string): HTMLElement {
  const wrap = el("div", "clva-odds-summary");

  const stat = (label: string, value: string, sub?: string, tone?: "good" | "bad") => {
    const s = el("span", "clva-odds-stat");
    s.appendChild(el("i", undefined, label));
    const b = el("b", tone === "good" ? "clva-good" : tone === "bad" ? "clva-bad" : undefined, value);
    s.appendChild(b);
    if (sub) s.appendChild(el("s", undefined, sub));
    wrap.appendChild(s);
  };

  const books = (n: number) => `${n} book${n === 1 ? "" : "s"}`;

  if (verdict.avgClosingLine !== null) {
    stat("Avg line", verdict.avgClosingLine.toFixed(2), books(verdict.closingBookCount));
  }
  // The reason this modal is worth opening on a whole-number market: the line on a passing-
  // touchdowns prop cannot move off 2.5, so the price is the only thing that ever does.
  if (verdict.avgClosingPrice !== null) {
    stat("Avg price", fmtOdds(verdict.avgClosingPrice), books(verdict.closingPriceBookCount));
  }
  if (verdict.edge !== null) {
    stat(
      "Edge",
      `${verdict.edge > 0 ? "+" : ""}${verdict.edge.toFixed(2)}`,
      undefined,
      verdict.edge > 0 ? "good" : verdict.edge < 0 ? "bad" : undefined
    );
  }

  const when = el("span", "clva-odds-stat");
  when.appendChild(el("s", undefined, `as of ${new Date(fetchedAt).toLocaleTimeString()}`));
  wrap.appendChild(when);
  return wrap;
}

function table(lines: OddsLookupLine[]): HTMLElement {
  const t = el("table", "clva-odds-table");
  const head = el("tr");
  head.appendChild(el("th", undefined, "Book"));
  head.appendChild(el("th", "clva-num", "Line"));
  head.appendChild(el("th", "clva-num", "Price"));
  const thead = el("thead");
  thead.appendChild(head);
  t.appendChild(thead);

  const body = el("tbody");
  for (const line of lines) {
    const tr = el("tr", line.includedInAverage ? undefined : "clva-excluded");
    const name = el("td");
    const box = el("span", "clva-odds-book");
    if (line.logoUrl) {
      const img = el("img");
      img.src = line.logoUrl;
      img.alt = "";
      // A board's own CSP can block an external image outright, and a broken-image glyph next to
      // every book is worse than no logos at all.
      img.addEventListener("error", () => img.remove());
      box.appendChild(img);
    }
    box.appendChild(el("span", undefined, line.label ?? line.bookKey));
    if (!line.includedInAverage) box.appendChild(el("s", undefined, "· not averaged"));
    name.appendChild(box);
    tr.appendChild(name);
    tr.appendChild(el("td", "clva-num", line.line === null ? "--" : String(line.line)));
    tr.appendChild(el("td", "clva-num", fmtOdds(line.price)));
    body.appendChild(tr);
  }
  t.appendChild(body);
  return t;
}

/**
 * Opens the modal and keeps it in sync with its own requests.
 *
 * Requests are tagged, so a Refresh fired while the first read is still in flight cannot be
 * overwritten by the older answer landing second -- the same guard the dashboard modal needs, for
 * the same reason.
 */
export function openOddsModal(pick: OddsLookupPick, label: string): void {
  const scrim = el("div", "clva-scrim");
  const modal = el("div", "clva-odds-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", `Current odds for ${label}`);

  const head = el("div", "clva-odds-head");
  const titles = el("div");
  titles.appendChild(el("h3", undefined, "Current odds"));
  titles.appendChild(el("div", "clva-sub", label));
  head.appendChild(titles);

  const actions = el("div", "clva-odds-head-actions");
  const refresh = el("button", undefined, "Refresh");
  refresh.type = "button";
  const close = el("button", undefined, "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  actions.append(refresh, close);
  head.appendChild(actions);
  modal.appendChild(head);

  const content = el("div");
  modal.appendChild(content);
  scrim.appendChild(modal);

  let requestId = 0;
  const done = () => {
    requestId++; // abandons anything still in flight
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      done();
    }
  };
  close.addEventListener("click", done);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) done();
  });
  // The board underneath has its own row handlers, and on OddsJam a click on a row opens their bet
  // slip. Nothing that happens inside this dialog is any of the board's business.
  scrim.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);

  const render = (build: () => HTMLElement) => {
    content.replaceChildren(build());
  };

  const load = (isRefresh: boolean) => {
    const mine = ++requestId;
    refresh.disabled = true;
    render(() => el("p", "clva-odds-wait", "Reading PropProfessor's odds screen…"));

    void (async () => {
      let response: OddsLookupResponse | undefined;
      try {
        response = await chrome.runtime.sendMessage({
          type: "clv:odds-lookup",
          pick: { ...pick, refresh: isRefresh },
        } satisfies OddsLookupMessage);
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : "the extension could not be reached",
        };
      }
      if (requestId !== mine) return;
      refresh.disabled = false;

      if (!response?.ok || !response.preview) {
        render(() => el("p", "clva-odds-msg", response?.error ?? "Could not read the odds screen."));
        return;
      }
      const preview = response.preview;
      if (!preview.ok || !preview.verdict) {
        render(() => el("p", "clva-odds-msg", preview.reason ?? "Nothing came back for this market."));
        return;
      }

      const verdict = preview.verdict;
      render(() => {
        const wrap = el("div");
        wrap.appendChild(summary(verdict, preview.fetchedAt));
        if (verdict.closeLines.length === 0) {
          wrap.appendChild(el("p", "clva-odds-msg", "No book columns came back for this market."));
        } else {
          wrap.appendChild(table(verdict.closeLines));
        }
        if (verdict.note) wrap.appendChild(el("p", "clva-odds-note", verdict.note));
        wrap.appendChild(
          el(
            "p",
            "clva-odds-note",
            "Sportsbook lines from PropProfessor's odds screen, averaged the same way a closing " +
              "read is."
          )
        );
        return wrap;
      });
    })();
  };

  refresh.addEventListener("click", () => load(true));
  document.body.appendChild(scrim);
  load(false);
}

/** The little button that opens it, sized to the checkbox so the column gets no wider. */
export function oddsButton(onOpen: () => void): HTMLButtonElement {
  const button = el("button", "clva-odds-btn");
  button.type = "button";
  button.title = "Current sportsbook odds for this market";
  button.setAttribute("aria-label", "Current sportsbook odds for this market");
  // A bar chart rather than a word: at 16px there is room for a glyph and nothing else, and this
  // one reads as "lines and prices" without competing with the board's own controls.
  //
  // Built node by node rather than assigned as `innerHTML`, because a site running Trusted Types
  // rejects an innerHTML assignment outright -- even from an isolated-world content script, and
  // even for a constant string like this one. A button that throws on creation would take the whole
  // injection pass down with it.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 10V7M6 10V3M10 10V5");
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  return button;
}
