import type { ParseResult, ParsedRow, BookLine, PickSide } from "../types";

/**
 * Parses the OddsJam Fantasy Optimizer table (fantasy.oddsjam.com/fantasy-odds/<book>).
 *
 * IMPORTANT: this function must stay fully self-contained -- no imports, no module-scope
 * references in its body -- because it is handed to Playwright's page.evaluate() at closing
 * time, which serializes it via Function.prototype.toString(). Every helper is nested inside.
 *
 * There are two board layouts (both verified against the live DOM, 2026-09):
 *
 *   player props (prizepicks, underdog, dabble, ...)
 *     TRACK | PLAYER NAME | O/U | STAT | <BOOK> LINE | % CHANCE TO HIT | <sportsbook logos...>
 *     The PLAYER NAME cell stacks three lines: player, "Team vs Team",
 *     "NFL - Sun, Sep 13 : 11:00 AM".
 *
 *   game markets (rebet, fliff, ...)
 *     Track | Game | Market | Bet Name | EV % | <sportsbook logos...>
 *     These are whole-game markets, not player props: "Point Spread / Seattle Seahawks +5.5",
 *     "Total Points / Over 29.5", "Asian Handicap Corners / SL Benfica -4.5". There is no player
 *     and no "% chance to hit" -- the board states an EV% directly, which is a different quantity
 *     and is carried through as boardEvPercent rather than converted into a probability.
 */
export const parseOddsJamTable = (): ParseResult => {
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

  const cellsOf = (row: Element): Element[] => {
    const roleCells = row.querySelectorAll(':scope > [role="cell"], :scope > [role="gridcell"]');
    if (roleCells.length) return Array.from(roleCells);
    return Array.from(row.querySelectorAll(":scope > td, :scope > th"));
  };

  const absoluteUrl = (src: string | null | undefined): string | null => {
    if (!src) return null;
    try {
      return new URL(src, location.origin).href;
    } catch {
      return null;
    }
  };

  const bookIdFrom = (
    headerCell: Element | null,
    index: number
  ): { key: string; label: string | null; logoUrl: string | null } => {
    if (headerCell) {
      const img = headerCell.querySelector("img");
      const logoUrl = absoluteUrl(img?.getAttribute("src"));
      const candidates: (string | null)[] = [
        img?.getAttribute("alt") ?? null,
        img?.getAttribute("title") ?? null,
        headerCell.getAttribute("aria-label"),
        headerCell.getAttribute("data-book"),
        headerCell.getAttribute("title"),
        img?.getAttribute("src") ?? null,
        norm((headerCell as HTMLElement).innerText ?? headerCell.textContent),
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
          const label = norm(c).replace(/^.*\//, "").replace(/\.(png|svg|jpg|jpeg|webp|gif)$/i, "");
          return { key: cleaned, label: label || null, logoUrl };
        }
      }
    }
    return { key: "col-" + index, label: null, logoUrl: null };
  };

  const parseBookCell = (
    cell: Element | null,
    key: string,
    label: string | null,
    logoUrl: string | null
  ): BookLine => {
    const rawText = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
    // Strip dollar figures (OddsJam shows suggested stake / handle under some prices).
    const stripped = rawText.replace(/\$\s*[\d,.]+[kKmM]?/g, " ");
    // Signed tokens are american prices; unsigned tokens are the book's line.
    const priceMatch = stripped.match(/[+-]\d{3,}/);
    const lineMatch = stripped.match(/(?:^|[^\d+.-])(\d+(?:\.\d+)?)/);
    return {
      bookKey: key,
      label,
      line: lineMatch ? parseFloat(lineMatch[1]) : null,
      price: priceMatch ? parseInt(priceMatch[0], 10) : null,
      logoUrl,
      rawText,
    };
  };

  const resolveIso = (timeText: string | null): string | null => {
    if (!timeText) return null;
    if (/live/i.test(timeText)) return null;
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const md = timeText.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})/);
    const tm = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!md || !tm) return null;
    const month = months[md[1].toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(md[2], 10);
    let hour = parseInt(tm[1], 10);
    const minute = parseInt(tm[2], 10);
    const mer = (tm[3] ?? "").toUpperCase();
    if (mer === "PM" && hour < 12) hour += 12;
    if (mer === "AM" && hour === 12) hour = 0;
    const now = new Date();
    // Times render without a year; pick the year that puts the game nearest to now.
    let candidate = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
    const dayMs = 86400000;
    if (candidate.getTime() < now.getTime() - 45 * dayMs) {
      candidate = new Date(now.getFullYear() + 1, month, day, hour, minute, 0, 0);
    } else if (candidate.getTime() > now.getTime() + 320 * dayMs) {
      candidate = new Date(now.getFullYear() - 1, month, day, hour, minute, 0, 0);
    }
    return candidate.toISOString();
  };

  // --- locate the grid -------------------------------------------------------
  const containers: Element[] = [
    ...Array.from(document.querySelectorAll("table")),
    ...Array.from(document.querySelectorAll('[role="table"], [role="grid"]')),
  ];

  type Layout = "PROPS" | "GAME";
  let table: Element | null = null;
  let headerCells: Element[] = [];
  let layout: Layout = "PROPS";

  for (const c of containers) {
    const headerRow =
      c.querySelector("thead tr") ??
      c.querySelector('[role="row"]:has([role="columnheader"])') ??
      c.querySelector('[role="rowgroup"] [role="row"]');
    if (!headerRow) continue;
    const hCells = Array.from(headerRow.querySelectorAll('th, [role="columnheader"]'));
    const headerText = hCells
      .map((h) => norm((h as HTMLElement).innerText ?? h.textContent))
      .join(" | ")
      .toUpperCase();
    if (headerText.includes("PLAYER") && headerText.includes("STAT")) {
      table = c;
      headerCells = hCells;
      layout = "PROPS";
      break;
    }
    // rebet / fliff: whole-game markets, so there is no PLAYER or STAT column to key off.
    if (headerText.includes("BET NAME") && headerText.includes("MARKET")) {
      table = c;
      headerCells = hCells;
      layout = "GAME";
      break;
    }
  }

  if (!table) {
    return { ok: false, reason: "OddsJam optimizer table not found", headers: [], rows: [] };
  }

  const headers = headerCells.map((h) => norm((h as HTMLElement).innerText ?? h.textContent));
  const upper = headers.map((h) => h.toUpperCase());
  const findCol = (pred: (h: string) => boolean): number => upper.findIndex(pred);

  const knownCols = new Set<number>();
  headers.forEach((h, i) => {
    const u = h.toUpperCase();
    if (u.includes("TRACK") || u.includes("CHANCE") || u.includes("CLV") || u.includes("EV")) {
      knownCols.add(i);
    }
  });

  const playerCol = findCol((h) => h.includes("PLAYER"));
  const ouCol = findCol((h) => h === "O/U" || h.includes("O/U"));
  const statCol = findCol((h) => h.includes("STAT"));
  const lineCol = findCol((h) => h.includes("LINE"));
  const chanceCol = findCol((h) => h.includes("CHANCE"));
  const gameCol = findCol((h) => h === "GAME");
  const marketCol = findCol((h) => h === "MARKET");
  const betNameCol = findCol((h) => h.includes("BET NAME"));
  const evCol = findCol((h) => h.replace(/\s+/g, "") === "EV%");
  for (const c of [playerCol, ouCol, statCol, lineCol, gameCol, marketCol, betNameCol]) {
    if (c >= 0) knownCols.add(c);
  }

  // Verified against the live DOM (2026-09): every book column renders an <img> whose alt is the
  // book name ("FanDuel", "Pinnacle", "PrizePicks (5 or 6 Pick Flex)", "OddsJam Algo Odds"),
  // while the labelled data columns and the unlabelled "Odds" link column never do.
  const bookCols: number[] = [];
  headerCells.forEach((h, i) => {
    if (knownCols.has(i)) return;
    if (!h.querySelector("img")) return;
    bookCols.push(i);
  });

  const bodyRows: Element[] = (() => {
    const tbodyRows = Array.from(table!.querySelectorAll("tbody tr"));
    if (tbodyRows.length) return tbodyRows;
    const roleRows = Array.from(table!.querySelectorAll('[role="row"]'));
    return roleRows.filter((r) => r.querySelector('[role="cell"], [role="gridcell"], td'));
  })();

  const rows: ParsedRow[] = [];

  const cellText = (cells: Element[], index: number): string =>
    index < 0
      ? ""
      : norm((cells[index] as HTMLElement | undefined)?.innerText ?? cells[index]?.textContent);

  const readBooks = (cells: Element[], side: PickSide | null): BookLine[] => {
    void side;
    const out: BookLine[] = [];
    for (const ci of bookCols) {
      const cell = cells[ci] ?? null;
      const text = norm((cell as HTMLElement | null)?.innerText ?? cell?.textContent ?? "");
      if (!text) continue;
      const { key, label, logoUrl } = bookIdFrom(headerCells[ci] ?? null, ci);
      out.push(parseBookCell(cell, key, label, logoUrl));
    }
    return out;
  };

  const rowId = (rowEl: Element): string | null => {
    // OddsJam row ids read "Aaron%20Rodgers%20Over%2014" (player + side + line). Stored as a
    // hint only: the embedded line moves before kickoff, which is the whole point of the tool,
    // so the close-time matcher keys on the identity fields instead.
    const rawId =
      rowEl.getAttribute("data-prop-id") ??
      rowEl.getAttribute("data-row-id") ??
      rowEl.getAttribute("data-id") ??
      rowEl.getAttribute("id");
    if (!rawId) return null;
    try {
      return decodeURIComponent(rawId);
    } catch {
      return rawId;
    }
  };

  const splitMatchup = (matchup: string | null): { team: string | null; opponent: string | null } => {
    if (!matchup) return { team: null, opponent: null };
    const vs = matchup.split(/\s+(?:vs\.?|@|at)\s+/i);
    return vs.length === 2 ? { team: vs[0].trim(), opponent: vs[1].trim() } : { team: null, opponent: null };
  };

  const splitMeta = (meta: string | null): { sport: string | null; timeText: string | null } => {
    if (!meta) return { sport: null, timeText: null };
    const parts = meta.split(/[\u2022\u00b7|]/).map((p) => p.trim()).filter(Boolean);
    return { sport: parts[0] ?? null, timeText: parts.slice(1).join(" ") || null };
  };

  bodyRows.forEach((rowEl, rowIndex) => {
    const cells = cellsOf(rowEl);
    if (!cells.length) return;

    if (layout === "GAME") {
      // --- whole-game markets (rebet, fliff) ---------------------------------
      const gameLines = lines(cells[gameCol] ?? null);
      const matchup = gameLines[0] ?? null;
      const { sport, timeText } = splitMeta(gameLines[gameLines.length - 1] ?? null);
      const { team, opponent } = splitMatchup(matchup);

      const statMarket = cellText(cells, marketCol) || null;
      const betName = cellText(cells, betNameCol) || null;

      let marketType: ParsedRow["marketType"] = "OTHER";
      let side: PickSide | null = null;
      let takenLine: number | null = null;
      let subjectTeam: string | null = null;
      let player: string | null = null;

      if (betName) {
        // "Over 29.5" / "Under 4" -- a total on the game, so it behaves exactly like an
        // over/under prop for CLV purposes.
        const total = betName.match(/^(Over|Under)\s+(-?\d+(?:\.\d+)?)$/i);
        // "Blaze Alexander Over 0.5" -- these boards are mostly game markets, but real player
        // props do appear among them, and they grade from a box score like any other prop.
        const prop = betName.match(/^(.+?)\s+(Over|Under)\s+(-?\d+(?:\.\d+)?)$/i);
        // "Seattle Seahawks +5.5" / "SL Benfica -4.5" -- a handicap on one team. The sign is
        // part of the number and must be kept: it is what the closing line is compared against.
        const spread = betName.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
        if (total) {
          marketType = "GAME_TOTAL";
          side = /over/i.test(total[1]) ? "OVER" : "UNDER";
          takenLine = parseFloat(total[2]);
        } else if (prop) {
          marketType = "PLAYER_PROP";
          player = prop[1].trim();
          side = /over/i.test(prop[2]) ? "OVER" : "UNDER";
          takenLine = parseFloat(prop[3]);
        } else if (spread) {
          marketType = "SPREAD";
          subjectTeam = spread[1].trim();
          takenLine = parseFloat(spread[2]);
        } else {
          // "Seattle Seahawks" -- no total/prop/spread number attached. A straight moneyline
          // pick names one of the game's two teams with nothing else added; free text that
          // doesn't ("Anytime Goal Scorer", correct-score, parlays, ...) is left as OTHER, since
          // there is no line or price on the row to measure it against.
          const lower = (s: string) => s.toLowerCase().trim();
          const named = [team, opponent].find((t) => t && lower(t) === lower(betName));
          if (named) {
            marketType = "MONEYLINE";
            subjectTeam = betName;
            // There is no number in the bet name to take as the line -- moneyline prices move,
            // not points. The comparison books quote a price per column same as any other game
            // market; that price is copied into `line` just below so the existing line-based
            // closing average works unchanged, and takenLine is the same-row average of it.
          }
        }
      }

      const evText = cellText(cells, evCol);
      const evMatch = evText.match(/(-?\d+(?:\.\d+)?)\s*%/);

      let bookLines = readBooks(cells, side);
      if (marketType === "MONEYLINE") {
        // Moneyline columns quote a price only -- `line` comes back null from parseBookCell.
        // Copying price into line here lets every downstream consumer (closing average,
        // includedInAverage, CLV) use the same line-based machinery unchanged; the sign works out
        // the same way a spread's line does (see MARKET_TYPES in server/src/lib/constants.ts).
        bookLines = bookLines.map((b) => (b.line === null ? { ...b, line: b.price } : b));
        const usable = bookLines.map((b) => b.line).filter((l): l is number => l !== null);
        if (usable.length > 0) {
          takenLine = Math.round((usable.reduce((sum, l) => sum + l, 0) / usable.length) * 100) / 100;
        }
      }

      rows.push({
        rowIndex,
        marketType,
        player,
        selectionName: betName,
        subjectTeam,
        isLive: false,
        team,
        opponent,
        matchup,
        sport,
        statMarket,
        side,
        takenLine,
        // These boards publish an EV%, not a win probability.
        fairProbability: null,
        boardEvPercent: evMatch ? parseFloat(evMatch[1]) : null,
        gameStartTimeText: timeText,
        gameStartTimeIso: resolveIso(timeText),
        externalPropId: rowId(rowEl),
        externalPlayerId: null,
        bookLines,
        rawText: norm((rowEl as HTMLElement).innerText ?? rowEl.textContent),
      });
      return;
    }

    // --- player props --------------------------------------------------------
    const playerLines = lines(cells[playerCol] ?? null);
    const player = playerLines[0] ?? null;
    const matchup = playerLines[1] ?? null;
    const { sport, timeText } = splitMeta(playerLines[2] ?? null);
    const { team, opponent } = splitMatchup(matchup);

    const sideText = cellText(cells, ouCol);
    const side: PickSide | null = /over/i.test(sideText)
      ? "OVER"
      : /under/i.test(sideText)
        ? "UNDER"
        : null;

    const statMarket = cellText(cells, statCol) || null;

    const lineText = cellText(cells, lineCol);
    const lineNum = lineText.match(/-?\d+(\.\d+)?/);
    const takenLine = lineNum ? parseFloat(lineNum[0]) : null;

    const chanceText = cellText(cells, chanceCol);
    const chanceMatch = chanceText.match(/(\d+(?:\.\d+)?)\s*%/);

    rows.push({
      rowIndex,
      marketType: "PLAYER_PROP",
      player,
      selectionName: player && side && takenLine !== null ? `${player} ${side === "OVER" ? "Over" : "Under"} ${takenLine}` : player,
      subjectTeam: null,
      isLive: false,
      team,
      opponent,
      matchup,
      sport,
      statMarket,
      side,
      takenLine,
      fairProbability: chanceMatch ? parseFloat(chanceMatch[1]) / 100 : null,
      boardEvPercent: null,
      gameStartTimeText: timeText,
      gameStartTimeIso: resolveIso(timeText),
      externalPropId: rowId(rowEl),
      externalPlayerId: null,
      bookLines: readBooks(cells, side),
      rawText: norm((rowEl as HTMLElement).innerText ?? rowEl.textContent),
    });
  });

  return { ok: true, headers, rows };
};
