import type { ParseResult, ParsedRow, BookLine, MarketType, PickSide } from "../types";

/**
 * Parses the PropProfessor Fantasy Optimizer grid (propprofessor.com/fantasy).
 *
 * Must stay fully self-contained (see the note in parsers/oddsjam.ts) -- it is serialized into
 * the page at closing time.
 *
 * Verified against the live DOM (2026-09). PropProfessor renders AG Grid, not a <table>, which
 * matters in two ways:
 *
 *  1. A logical row is split across several [role="row"] elements (pinned columns + centre
 *     viewport), all sharing one `row-id`. Cells must be merged by row-id or most of the book
 *     columns are missed entirely.
 *  2. Columns carry a stable `col-id` that is the book name ("FanDuel", "Pinnacle", "Kalshi"),
 *     so books are keyed by col-id rather than by column position.
 *
 * There are two board layouts, and they differ in more than cosmetics:
 *
 *   standard ("PrizePicks", "Dabble", ...)   cols: actions? game selection value <books>
 *     row-id  NFL:GAME:Rams:49ers:1789086900:Player_Receiving_Yards:Puka_Nacua_Over_62.5
 *     selection cell holds two lines: the market, then "Player Over 62.5"
 *     `value` is the no-vig win probability, already a percentage
 *
 *   alt ("Dabble (Alt)", "PrizePicks (Alt)", ...)  cols: actions game selection market ev odds
 *                                                        noVigOdds <books>
 *     row-id  NFL:GAME:Panthers:Bears:1789318800:Dabble (Alt):Player_Receptions:Luther_Burden_Over_4.5
 *     the book name is spliced in as an extra segment, the market has its own column, and the
 *     selection cell holds only "Luther Burden Over 4.5"
 *     there is no `value`; `noVigOdds` is a price, and `ev` is already an EV% (a different
 *     quantity entirely -- using it as a probability would be badly wrong)
 *
 * Because the alt row-id is one segment longer, the identity segments are read from the END of
 * the id rather than by fixed index: the last is always player_side_line and the one before it is
 * always the market, on both layouts.
 */
export const parsePropProfessorTable = (): ParseResult => {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").replace(/\s+/g, " ").trim();

  const lines = (el: Element | null): string[] => {
    if (!el) return [];
    const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return raw
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0);
  };

  /** American odds -> implied probability. The alt board quotes no-vig as a price, not a %. */
  const impliedFromAmerican = (price: number): number | null => {
    if (!Number.isFinite(price) || price === 0) return null;
    return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
  };

  const absoluteUrl = (src: string | null | undefined): string | null => {
    if (!src) return null;
    try {
      return new URL(src, location.origin).href;
    } catch {
      return null;
    }
  };

  const bookIdFromHeader = (
    headerCell: Element | null,
    colId: string
  ): { key: string; label: string | null; logoUrl: string | null } => {
    const img = headerCell?.querySelector("img") ?? null;
    const logoUrl = absoluteUrl(img?.getAttribute("src"));
    const candidates: (string | null)[] = [
      img?.getAttribute("alt") ?? null,
      img?.getAttribute("title") ?? null,
      headerCell?.getAttribute("aria-label") ?? null,
      colId,
    ];
    for (const c of candidates) {
      if (!c) continue;
      const cleaned = c
        .toLowerCase()
        .replace(/\?.*$/, "")
        .replace(/\.(png|svg|jpg|jpeg|webp|gif)$/, "")
        .replace(/^.*\//, "")
        .replace(/[^a-z0-9]/g, "");
      if (cleaned && cleaned.length > 1 && !/^\d+$/.test(cleaned)) {
        return { key: cleaned, label: norm(c) || null, logoUrl };
      }
    }
    return { key: "col-" + colId, label: colId || null, logoUrl };
  };

  const parseBookCell = (
    cell: Element | null,
    key: string,
    label: string | null,
    logoUrl: string | null
  ): BookLine => {
    const rawText = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
    // Drop suggested-stake figures ("$111 / $696") before reading numbers.
    const stripped = rawText.replace(/\$\s*[\d,.]+[kKmM]?/g, " ");
    // Signed tokens are american prices. The pair is ordered [this row's side, the other side] --
    // not [over, under] -- so the left token is always the one this row is for, regardless of the
    // row's own side. An under row showing "-116/+118" means -116 IS the under price, not +118.
    const priceTokens: string[] = stripped.match(/[+-]\d{3,}/g) ?? [];
    const lineMatch = stripped.match(/(?:^|[^\d+.-])(\d+(?:\.\d+)?)/);
    return {
      bookKey: key,
      label,
      line: lineMatch ? parseFloat(lineMatch[1]) : null,
      price: priceTokens.length ? parseInt(priceTokens[0], 10) : null,
      logoUrl,
      rawText,
    };
  };

  /**
   * Whether the board is showing Live rather than Pre-Match.
   *
   * The toggle is a pair of pills with no URL component, so the state has to be read off the DOM.
   * Explicit ARIA/data state is preferred; the fallback compares how opaque each pill's own
   * background is, which survives the Tailwind class churn that naming a class would not.
   */
  const detectLive = (): boolean => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const find = (label: string) =>
      buttons.find((b) => norm(b.textContent).toLowerCase() === label) ?? null;
    const live = find("live");
    const pre = find("pre-match");
    if (!live) return false;

    const explicit = (el: Element): boolean | null => {
      const pressed = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected");
      if (pressed === "true") return true;
      if (pressed === "false") return false;
      const state = el.getAttribute("data-state");
      if (state) return /active|on|selected|checked/i.test(state);
      return null;
    };
    const liveExplicit = explicit(live);
    if (liveExplicit !== null) return liveExplicit;
    if (!pre) return false;

    const opacity = (el: Element): number => {
      const bg = getComputedStyle(el).backgroundColor || "";
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return 0;
      const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
      return parts.length >= 4 ? parts[3] : 1;
    };
    return opacity(live) > opacity(pre);
  };

  // --- locate the grid -------------------------------------------------------
  const grid =
    document.querySelector('[role="grid"], [role="table"]') ??
    (document.querySelector('[role="row"][row-id]')?.closest("div") ?? null);

  if (!grid) {
    return { ok: false, reason: "PropProfessor fantasy grid not found", headers: [], rows: [] };
  }

  const isLive = detectLive();

  const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"]'));
  const headerByColId = new Map<string, Element>();
  for (const h of headerCells) {
    const cid = h.getAttribute("col-id");
    if (cid) headerByColId.set(cid, h);
  }
  const headers = headerCells.map((h) => {
    const cid = h.getAttribute("col-id") ?? "";
    const img = h.querySelector("img");
    return norm(img?.getAttribute("alt") ?? (h as HTMLElement).innerText ?? h.textContent) || cid;
  });

  /**
   * Data columns, never books. `noVigOdds` has to be listed explicitly: it carries a logo image
   * (PropProfessor's own), so the "has an <img> means it is a book" test would otherwise let it
   * through and feed the site's own fair price into the closing average as if it were a book.
   */
  const reserved = new Set([
    "actions",
    "game",
    "selection",
    "value",
    "stability",
    "clv",
    "market",
    "ev",
    "odds",
    "novigodds",
    // Boards with no pinned actions column (see propprofessor/index.ts's mountCell fallback)
    // spell out participant/market/line separately instead of folding them into "selection".
    "participant",
    "line",
    "selectiontype",
  ]);
  const isBookCol = (colId: string): boolean => {
    if (reserved.has(colId.toLowerCase())) return false;
    const h = headerByColId.get(colId);
    if (h && h.querySelector("img")) return true;
    return !!h;
  };

  // --- merge the pinned/centre halves of each logical row --------------------
  const rowEls = Array.from(grid.querySelectorAll('[role="row"][row-id]'));
  const order: string[] = [];
  const partsByRowId = new Map<string, Element[]>();
  for (const el of rowEls) {
    const rid = el.getAttribute("row-id");
    if (!rid) continue;
    if (!partsByRowId.has(rid)) {
      partsByRowId.set(rid, []);
      order.push(rid);
    }
    partsByRowId.get(rid)!.push(el);
  }

  const rows: ParsedRow[] = [];
  const unslug = (s: string | undefined | null): string | null =>
    s ? s.replace(/_/g, " ").trim() || null : null;
  // The name before "Over"/"Under" is optional: game/team totals (e.g. tennis "Total Games") have
  // no player and the selection cell reads simply "Over 19.5". `\s+` between the groups would
  // never match that (nothing to put whitespace after), silently dropping takenLine for every
  // such market -- `\s*` lets the name group come back empty instead.
  const PICK_RE = /^(.*?)\s*(Over|Under)\s+(-?\d+(?:\.\d+)?)\s*$/i;

  order.forEach((rowId, rowIndex) => {
    const parts = partsByRowId.get(rowId) ?? [];
    const cellByColId = new Map<string, Element>();
    for (const part of parts) {
      const cells = Array.from(part.querySelectorAll('[role="cell"], [role="gridcell"]'));
      for (const c of cells) {
        const cid = c.getAttribute("col-id");
        if (cid && !cellByColId.has(cid)) cellByColId.set(cid, c);
      }
    }
    if (cellByColId.size === 0) return;

    // --- structured identity straight off the row-id -------------------------
    // Read from the end: the alt layout splices the book name in at index 5, so fixed indexing
    // from the front silently returns the book where the market should be.
    const idParts = rowId.split(":");
    let sport: string | null = null;
    let team: string | null = null;
    let opponent: string | null = null;
    let epochSeconds: number | null = null;
    let marketFromId: string | null = null;
    let pickFromId: string | null = null;
    if (idParts.length >= 7 && idParts[1] === "GAME") {
      sport = unslug(idParts[0]);
      team = unslug(idParts[2]);
      opponent = unslug(idParts[3]);
      const epoch = parseInt(idParts[4], 10);
      if (Number.isFinite(epoch) && epoch > 0) epochSeconds = epoch;
      marketFromId = unslug(idParts[idParts.length - 2]);
      pickFromId = unslug(idParts[idParts.length - 1]);
    }

    const selLines = lines(cellByColId.get("selection") ?? null);
    // The alt board puts the market in its own column; the standard board makes it selection[0].
    const marketCellText = norm(
      (cellByColId.get("market") as HTMLElement | undefined)?.innerText ??
        cellByColId.get("market")?.textContent
    );
    // Whichever line actually parses as "<name> Over|Under <number>" is the pick; that is
    // selection[1] on the standard layout and selection[0] on the alt one.
    const pickLine =
      selLines.find((l) => PICK_RE.test(l)) ??
      (marketCellText ? selLines[0] : selLines[1]) ??
      pickFromId;

    const statMarket =
      marketCellText ||
      (selLines.length > 1 && !PICK_RE.test(selLines[0]) ? selLines[0] : null) ||
      marketFromId;

    let player: string | null = null;
    let side: PickSide | null = null;
    let takenLine: number | null = null;
    // Most rows here are player props, but a market like tennis "Total Games" has no player --
    // just "Over 19.5" -- and matching.ts's matchKeyForRow keys those by market+side instead, so
    // `player` has to stay null rather than fall back to the pick text (which would collide with
    // an actual, differently-worded player prop on the same market).
    let marketType: MarketType = "PLAYER_PROP";
    if (pickLine) {
      const m = pickLine.match(PICK_RE);
      if (m) {
        const name = m[1].trim();
        side = /over/i.test(m[2]) ? "OVER" : "UNDER";
        takenLine = parseFloat(m[3]);
        if (name) player = name;
        else marketType = "GAME_TOTAL";
      } else {
        player = pickLine;
      }
    }

    const gameLines = lines(cellByColId.get("game") ?? null);
    const matchup = gameLines[0] ?? (team && opponent ? `${team} vs ${opponent}` : null);
    const gameMeta = gameLines[1] ?? null;
    let gameStartTimeText: string | null = null;
    if (gameMeta) {
      const parts2 = gameMeta.split(/[•·|]/).map((p) => p.trim()).filter(Boolean);
      if (!sport && parts2[0]) sport = parts2[0];
      gameStartTimeText = parts2.slice(1).join(" ") || gameMeta;
    }

    // Fair probability: `value` is already a no-vig percentage on the standard board. The alt
    // board has no `value` column -- its `ev` column fills that role instead, but it is not an
    // expected-value percentage the way the name suggests: it reads centred on a 50% coin flip
    // (0% == 50% to hit), not on 0% risk-adjusted return, so a displayed "7%" is a 57% win
    // probability. `noVigOdds` (a price) is kept as a fallback for the rare row where `ev` itself
    // doesn't parse.
    let fairProbability: number | null = null;
    const valueText = norm(
      (cellByColId.get("value") as HTMLElement | undefined)?.innerText ??
        cellByColId.get("value")?.textContent
    );
    const valueMatch = valueText.match(/(\d+(?:\.\d+)?)\s*%/);
    if (valueMatch) {
      fairProbability = parseFloat(valueMatch[1]) / 100;
    } else {
      const evText = norm(
        (cellByColId.get("ev") as HTMLElement | undefined)?.innerText ??
          cellByColId.get("ev")?.textContent
      );
      const evMatch = evText.match(/(-?\d+(?:\.\d+)?)\s*%/);
      if (evMatch) {
        fairProbability = 0.5 + parseFloat(evMatch[1]) / 100;
      } else {
        const noVigText = norm(
          (cellByColId.get("noVigOdds") as HTMLElement | undefined)?.innerText ??
            cellByColId.get("noVigOdds")?.textContent
        );
        const priceMatch = noVigText.match(/[+-]\d{3,}/);
        if (priceMatch) fairProbability = impliedFromAmerican(parseInt(priceMatch[0], 10));
      }
    }

    const bookLines: BookLine[] = [];
    for (const [colId, cell] of cellByColId) {
      if (!isBookCol(colId)) continue;
      const text = norm((cell as HTMLElement).innerText ?? cell.textContent ?? "");
      if (!text) continue;
      const { key, label, logoUrl } = bookIdFromHeader(headerByColId.get(colId) ?? null, colId);
      bookLines.push(parseBookCell(cell, key, label, logoUrl));
    }

    rows.push({
      rowIndex,
      marketType,
      player,
      selectionName: pickLine ?? null,
      subjectTeam: null,
      isLive,
      team,
      opponent,
      matchup,
      sport,
      statMarket,
      side,
      takenLine,
      fairProbability,
      // PropProfessor publishes a fair probability, so EV is derived from it rather than stated.
      boardEvPercent: null,
      gameStartTimeText,
      // The row-id epoch is authoritative; the rendered text is only a fallback label.
      gameStartTimeIso: epochSeconds ? new Date(epochSeconds * 1000).toISOString() : null,
      externalPropId: rowId,
      externalPlayerId: null,
      bookLines,
      rawText: parts.map((p) => norm((p as HTMLElement).innerText ?? p.textContent)).join(" "),
    });
  });

  return { ok: true, headers, rows };
};
