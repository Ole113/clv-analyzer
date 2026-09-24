/**
 * Turning one Odds Terminal fixture's odds into the rows every other source in this project
 * produces.
 *
 * ## Where these entries come from
 *
 * `/api/snapshot?...&fixture_id=<id>&mode=all` -- one plain JSON request, which returns every
 * market that fixture has: game lines, team totals, period markets and **every player prop**,
 * roughly 2,300 entries across 112 markets for an NFL game with five books attached.
 *
 * This module used to parse Server-Sent Events instead, on the belief that props were only
 * available on `/api/stream`. They are not, and that stream answers a fixture query with 200 and
 * then silence, so every prop lookup timed out. There is no stream in this source any more, and no
 * `EventSource`, no reconnect policy and no read window to tune -- a request either answers or it
 * does not. See `odds-terminal-event.ts` for the two requests a lookup makes.
 *
 * ## Markets are matched by NAME, never by id
 *
 * This is the load-bearing decision, and it is what makes "every player prop" achievable rather
 * than a table someone has to keep feeding. The feed's `market_id` is a slug of its own display
 * name, punctuation and all -- `"Player Hits + Runs + RBIs"` is `player_hits_+_runs_+_rbis`, with
 * literal `+` characters in an identifier. Hand-written ids for those are wrong more often than
 * right, and a wrong id renders as an empty modal with nothing to explain it.
 *
 * So nothing is named in advance. The fixture read returns everything, and the filtering happens
 * here, against the set of acceptable names `oddsTerminalMarketKeys` derived from the pick (board
 * spelling, this project's canonical name, and the period-prefixed form this feed uses).
 */

import type { MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import { bookLogoUrl } from "../books";
import { normalizeName } from "../matching";
import { devigTwoWay } from "../devig";
import { pickMainLines, type BookQuote } from "./main-line";
import {
  normalizeOddsTerminalBookKey,
  oddsTerminalFixtureTeams,
  oddsTerminalMarketKey,
  type OddsTerminalFixture,
  type OddsTerminalReadPlan,
} from "./odds-terminal-event";

/** One `odds[]` entry. Every field is treated as untrusted. */
export interface OddsTerminalOddsEntry {
  fixture_id?: unknown;
  market?: unknown;
  market_id?: unknown;
  sportsbook?: unknown;
  name?: unknown;
  selection?: unknown;
  normalized_selection?: unknown;
  /** "over" | "under" | null. Stated outright, so no side has to be parsed out of a label. */
  selection_line?: unknown;
  price?: unknown;
  points?: unknown;
  selection_points?: unknown;
  player_id?: unknown;
  team_id?: unknown;
  is_main?: unknown;
  is_live?: unknown;
  /** `{ max }` -- the largest stake the book will take, which on an exchange is real depth. */
  limits?: unknown;
  /** `[[price, size], ...]` for exchanges. */
  order_book?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Whether one entry is about the market the pick is about. */
export function isOddsTerminalMarketMatch(
  entryMarket: string | null | undefined,
  marketKeys: string[]
): boolean {
  const key = oddsTerminalMarketKey(entryMarket);
  return key !== "" && marketKeys.includes(key);
}

/** The odds a snapshot body carried, or an empty list. */
export function oddsTerminalOddsOf(body: unknown): OddsTerminalOddsEntry[] {
  if (!body || typeof body !== "object") return [];
  const odds = (body as { odds?: unknown }).odds;
  return Array.isArray(odds) ? (odds as OddsTerminalOddsEntry[]) : [];
}

/**
 * The entries worth keeping out of a fixture read, and the market names it did carry.
 *
 * Called where the bytes land, before anything is passed on. A fixture read is 2-3 MB and all but
 * a few dozen entries of it are about markets nobody asked for; forwarding the whole thing to the
 * server would mean pushing megabytes through `chrome.runtime` and an HTTP POST for a table of
 * nine rows. `marketsSeen` is kept because the actionable failure is almost always "that market is
 * spelled differently here", and naming what *was* on offer is what makes it fixable.
 */
export function filterOddsTerminalOdds(
  entries: OddsTerminalOddsEntry[],
  plan: OddsTerminalReadPlan,
  fixtureId: string | null
): { entries: OddsTerminalOddsEntry[]; marketsSeen: string[] } {
  const kept: OddsTerminalOddsEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (fixtureId !== null && str(entry.fixture_id) !== fixtureId) continue;
    const market = str(entry.market);
    if (market) seen.add(market);
    if (isOddsTerminalMarketMatch(market, plan.marketKeys)) kept.push(entry);
  }
  return { entries: kept, marketsSeen: [...seen] };
}

/** How many distinct books have something to say about the pick's market. */
export function oddsTerminalBookCoverage(entries: OddsTerminalOddsEntry[]): number {
  const books = new Set<string>();
  for (const entry of entries) {
    const book = str(entry?.sportsbook);
    if (book) books.add(book);
  }
  return books.size;
}

/** The money actually resting behind a quote, where the book publishes it. */
function liquidityOf(entry: OddsTerminalOddsEntry): number | null {
  const limits = entry.limits;
  if (limits && typeof limits === "object") {
    const max = num((limits as { max?: unknown }).max);
    if (max !== null) return max;
  }
  // Falls back to the size at the best price on the book's own ladder.
  const book = entry.order_book;
  if (Array.isArray(book) && Array.isArray(book[0])) {
    const size = num((book[0] as unknown[])[1]);
    if (size !== null) return size;
  }
  return null;
}

/**
 * Turns a fixture's odds entries into rows the matcher and verdict builder understand.
 *
 * Emits one row per (selection, side), exactly as every other source in this project does, so
 * nothing downstream can tell which source produced a row.
 *
 * Two things this gets that a scraped board cannot give:
 *
 *  - **The side is stated.** `selection_line` is literally "over"/"under", so no side has to be
 *    recovered from a label like "Travis Kelce Over 4.5".
 *  - **Real depth.** Exchange entries carry `limits.max` and a full `order_book`, so the modal's
 *    liquidity column has actual numbers behind it rather than nulls.
 */
export function normalizeOddsTerminalOdds(
  entries: OddsTerminalOddsEntry[],
  plan: OddsTerminalReadPlan,
  fixture: OddsTerminalFixture,
  options: { atLine?: number | null; marketsSeen?: string[] } = {}
): ParseResult {
  try {
    if (!Array.isArray(entries)) {
      return { ok: false, reason: "the read carried no entries", headers: [], rows: [] };
    }
    const fixtureId = str(fixture.id);
    const { home, away } = oddsTerminalFixtureTeams(fixture);
    const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
    const atLine =
      plan.marketType === "MONEYLINE" || typeof options.atLine !== "number" ? null : options.atLine;

    const wanted = plan.requestedStatMarket;
    const marketsSeen = new Set<string>(options.marketsSeen ?? []);

    // One book's two sides at one line, paired before either is usable: a de-vig needs both and
    // the main-line choice is made from both. Keyed on book + selection + line, with the parts
    // carried on the value rather than parsed back out of the key -- player and book names both
    // contain spaces and punctuation.
    interface Pair {
      sportsbook: string;
      selection: string;
      one: OddsTerminalOddsEntry | null;
      two: OddsTerminalOddsEntry | null;
    }
    const pairs = new Map<string, Pair>();

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (fixtureId !== null && str(entry.fixture_id) !== fixtureId) continue;

      const market = str(entry.market);
      if (market) marketsSeen.add(market);
      if (!isOddsTerminalMarketMatch(market, plan.marketKeys)) continue;

      const sportsbook = str(entry.sportsbook);
      if (!sportsbook) continue;

      // A game total carries an empty `selection` -- the market names itself and there is no
      // player or team to name. Only the markets whose side IS a team need one, which is why this
      // is not a blanket "skip entries with no selection": that is exactly what dropped every
      // total on the floor, leaving a totals lookup looking like a market the feed does not carry.
      const selectionRaw = str(entry.selection) ?? str(entry.normalized_selection) ?? "";
      if (!selectionRaw && isGameMarket) continue;

      let side: 1 | 2 | null = null;
      let selection = "";
      if (isGameMarket) {
        // The selection is a team. A three-way market's "Draw" belongs to neither side and has no
        // row to go in, which the null fall-through handles.
        const normalized = normalizeName(selectionRaw);
        if (home && normalized === normalizeName(home)) side = 1;
        else if (away && normalized === normalizeName(away)) side = 2;
        selection = "";
      } else {
        const line = str(entry.selection_line)?.toLowerCase();
        side = line === "over" ? 1 : line === "under" ? 2 : null;
        selection = selectionRaw;
      }
      if (side === null) continue;

      const points = num(entry.points) ?? num(entry.selection_points);
      // What makes two entries the two halves of one market, which is not the same question for
      // every market type:
      //
      //  - a prop or a total is two sides of ONE number, so the number is part of the key;
      //  - a spread is two sides of one number with **opposite signs** -- Chiefs -10.5 and Dolphins
      //    +10.5 -- so it keys on the magnitude. Keying it like a total put each team's own line in
      //    a pair of its own, and the row then averaged -10.5 and +10.5 together into a spread of
      //    about six points for both teams;
      //  - a moneyline has no number at all.
      const pairKey =
        plan.marketType === "MONEYLINE"
          ? sportsbook
          : plan.marketType === "SPREAD"
            ? `${sportsbook}::${points === null ? "null" : Math.abs(points)}`
            : `${sportsbook}::${selection}::${points ?? "null"}`;
      const pair = pairs.get(pairKey) ?? { sportsbook, selection, one: null, two: null };
      if (side === 1) pair.one = entry;
      else pair.two = entry;
      pairs.set(pairKey, pair);
    }

    const bySelection = new Map<string, { one: BookQuote[]; two: BookQuote[] }>();
    for (const { sportsbook, selection, one, two } of pairs.values()) {
      const priceOne = num(one?.price);
      const priceTwo = num(two?.price);
      if (priceOne === null && priceTwo === null) continue;

      const pointsOne = num(one?.points) ?? num(one?.selection_points);
      const pointsTwo = num(two?.points) ?? num(two?.selection_points);
      const bucket = bySelection.get(selection) ?? { one: [], two: [] };
      const bookKey = normalizeOddsTerminalBookKey(sportsbook);

      // The feed's own word on which line is this book's main number, taken from either side: a
      // book sometimes flags only the side it considers the primary one, and the OVER row and the
      // UNDER row have to agree about which line they are describing.
      const isMain = one?.is_main === true || two?.is_main === true;

      bucket.one.push({
        bookKey,
        label: sportsbook,
        line: plan.marketType === "MONEYLINE" ? priceOne : (pointsOne ?? pointsTwo),
        price: priceOne,
        otherSidePrice: priceTwo,
        liquidity: one ? liquidityOf(one) : null,
        isMain,
      });
      bucket.two.push({
        bookKey,
        label: sportsbook,
        line: plan.marketType === "MONEYLINE" ? priceTwo : (pointsTwo ?? pointsOne),
        price: priceTwo,
        otherSidePrice: priceOne,
        liquidity: two ? liquidityOf(two) : null,
        isMain,
      });
      bySelection.set(selection, bucket);
    }

    const rows: ParsedRow[] = [];
    for (const [selection, bucket] of bySelection) {
      for (const side of [1, 2] as const) {
        const row = buildRow({
          plan,
          selection,
          quotes: side === 1 ? bucket.one : bucket.two,
          side,
          sideName: side === 1 ? (home ?? "Home") : (away ?? "Away"),
          home,
          away,
          rowIndex: rows.length,
          atLine,
          fixture,
        });
        if (row) rows.push(row);
      }
    }

    if (rows.length === 0 && marketsSeen.size > 0) {
      // Names the markets that *were* on offer, because the actionable failure here is almost
      // always a market spelled differently rather than a market that is missing.
      const props = [...marketsSeen].filter((m) => /^player\b/i.test(m));
      const shown = (props.length > 0 ? props : [...marketsSeen]).slice(0, 8);
      return {
        ok: false,
        reason:
          `Odds Terminal is not quoting "${wanted}" on this game. It is showing: ` +
          `${shown.join(", ")}${marketsSeen.size > shown.length ? ", ..." : ""}`,
        headers: [],
        rows: [],
      };
    }

    return {
      ok: true,
      headers: [plan.sport, plan.league, wanted],
      rows,
      reason: rows.length === 0 ? "the read carried no priced selections" : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not read the odds",
      headers: [],
      rows: [],
    };
  }
}

function buildRow(input: {
  plan: OddsTerminalReadPlan;
  selection: string;
  quotes: BookQuote[];
  side: 1 | 2;
  sideName: string;
  home: string | null;
  away: string | null;
  rowIndex: number;
  atLine: number | null;
  fixture: OddsTerminalFixture;
}): ParsedRow | null {
  const { plan, selection, side, sideName, home, away, atLine, fixture } = input;
  const books = pickMainLines(input.quotes, atLine);
  if (books.size === 0) return null;

  const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
  const pickSide: PickSide | null = isGameMarket ? null : side === 1 ? "OVER" : "UNDER";

  const bookLines = [...books.entries()]
    .filter(([, b]) => plan.marketType !== "MONEYLINE" || b.price !== null)
    .filter(([, b]) => plan.marketType === "MONEYLINE" || b.nearMarket)
    .map(([bookKey, b]) => {
      const alts = b.selectionsSeen.filter((l) => l !== b.line);
      return {
        bookKey,
        label: b.label,
        line: b.line,
        price: b.price,
        // Real numbers here, unlike every other source in this project: the feed publishes each
        // quote's own depth.
        liquidity: b.liquidity,
        fairProbability: devigTwoWay(b.price, b.otherSidePrice),
        priceAtLine: b.priceAtLine,
        logoUrl: bookLogoUrl(bookKey, b.label),
        rawText:
          `${b.line ?? "-"} @ ${b.price ?? "no price this side"}` +
          (alts.length > 0 ? ` (also quoted ${alts.join(", ")})` : "") +
          (atLine !== null && b.line !== atLine
            ? `; at ${atLine}: ${b.priceAtLine ?? "not quoted"}`
            : ""),
      };
    });

  if (bookLines.length === 0) return null;

  const usable = bookLines.map((b) => b.line).filter((l): l is number => l !== null);
  const takenLine =
    usable.length > 0
      ? Math.round((usable.reduce((sum, l) => sum + l, 0) / usable.length) * 100) / 100
      : null;

  const startDate = str(fixture.start_date);

  return {
    rowIndex: input.rowIndex,
    marketType: plan.marketType,
    player: isGameMarket ? null : (selection || null),
    // A game total has no player and no team, so it names itself by its side -- "Over"/"Under" --
    // rather than borrowing the home team's name, which is what `sideName` holds.
    selectionName: isGameMarket
      ? sideName
      : selection || (pickSide === "OVER" ? "Over" : "Under"),
    subjectTeam: isGameMarket ? sideName : null,
    isLive: fixture.is_live === true,
    team: home,
    opponent: away,
    matchup: home && away ? `${away} vs ${home}` : null,
    sport: plan.league.toUpperCase(),
    statMarket: plan.requestedStatMarket,
    side: pickSide,
    takenLine,
    fairProbability: null,
    boardEvPercent: null,
    gameStartTimeText: startDate,
    gameStartTimeIso: startDate,
    externalPropId: null,
    externalPlayerId: null,
    externalGameId: str(fixture.id),
    bookLines,
    rawText: JSON.stringify({
      source: "odds-terminal",
      sport: plan.sport,
      league: plan.league,
      market: plan.requestedStatMarket,
      fixtureId: str(fixture.id),
      selection,
      bookCount: bookLines.length,
    }),
  };
}
