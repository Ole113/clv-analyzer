/**
 * Odds Terminal's `/api/stream`, which is where the player props actually live.
 *
 * ## Why this exists separately from `odds-terminal-event.ts`
 *
 * The first build of this source was written against `/api/snapshot`, on the assumption that it
 * carried every market. It does not: verified live across all sixteen sports, that endpoint serves
 * *main markets only* -- moneyline, a spread and a total -- and silently ignores a `market`
 * parameter. Player props come from a **Server-Sent Events stream**, a different endpoint with a
 * different shape and different semantics, so it gets its own module rather than a flag.
 *
 * The two are used together, in that order:
 *
 *   1. `/api/snapshot` resolves which fixture the pick is about (it lists fixtures; the stream
 *      requires a `fixture_id` and will not hand one out).
 *   2. `/api/stream?...&fixture_id=<id>&mode=all` delivers that fixture's markets as SSE events.
 *
 * ## Markets are matched by NAME, not by id
 *
 * This is the load-bearing decision here, and it is what makes "every player prop" achievable
 * rather than a table someone has to keep feeding.
 *
 * The feed's `market_id` is a slug of its own display name, punctuation and all:
 * `"Player Hits + Runs + RBIs"` becomes `player_hits_+_runs_+_rbis`, with literal `+` characters
 * in an identifier. Guessing those ids is exactly the trap the first build fell into -- every one
 * of the ~50 hand-written ids was wrong, and each wrong id is an empty tab with nothing to explain
 * it.
 *
 * But `mode=all` returns *every* market for the fixture, so nothing has to be guessed up front:
 * the stream is filtered client-side by running the feed's own `market` display name and the
 * pick's `statMarket` through `marketFilterKey`, the normalizer this project already uses for
 * exactly this job. It collapses `+` to " plus " and strips a leading "Player ", so
 * `"Hits + Runs + RBIs"` from a board and `"Player Hits + Runs + RBIs"` from the feed both reduce
 * to `hits plus runs plus rbis` and match with no table at all. Checked against the live sample:
 * seven of the eight market spellings in this user's own database match directly.
 *
 * `MARKET_ALIASES` below is only for the genuine board-side synonyms that normalization cannot
 * reach, and it is deliberately tiny.
 */

import type { MarketType, ParseResult, ParsedRow, PickSide } from "../types";
import { bookLogoUrl } from "../books";
import { marketFilterKey } from "../markets";
import { normalizeName } from "../matching";
import { devigTwoWay } from "../devig";
import { pickMainLines, type BookQuote } from "./main-line";
import {
  normalizeOddsTerminalBookKey,
  oddsTerminalFixtureTeams,
  oddsTerminalStreamBooks,
  type OddsTerminalFixture,
  type OddsTerminalReadPlan,
} from "./odds-terminal-event";

/** One `data[]` entry of an `event: odds` message. Every field is treated as untrusted. */
export interface OddsTerminalStreamEntry {
  fixture_id?: unknown;
  market?: unknown;
  market_id?: unknown;
  sportsbook?: unknown;
  sportsbook_id?: unknown;
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

/**
 * Board spellings that `marketFilterKey` alone cannot reconcile with the feed's own name.
 *
 * Kept deliberately small. Anything that can be handled by normalization must be, because a table
 * of market names is the thing that rots -- every entry here is a standing maintenance cost and a
 * place for the two vocabularies to drift apart silently.
 */
const MARKET_ALIASES: Record<string, string> = {
  // A DFS board writes total bases as bare "Bases".
  bases: "total bases",
  // Boards abbreviate; the feed spells it out.
  "3 pointers made": "three pointers made",
  "threes made": "three pointers made",
  "made threes": "three pointers made",
  "blks plus stls": "blocks plus steals",
  "pts plus reb plus ast": "points plus rebounds plus assists",
  sog: "shots on goal",
};

/** The comparable form of a market name, from either side of the wire. */
function marketKey(name: string | null | undefined): string {
  const key = marketFilterKey(name);
  return MARKET_ALIASES[key] ?? key;
}

/** Whether one stream entry is about the market the pick is about. */
export function isOddsTerminalMarketMatch(
  entryMarket: string | null | undefined,
  pickStatMarket: string | null | undefined
): boolean {
  const a = marketKey(entryMarket);
  const b = marketKey(pickStatMarket);
  return a !== "" && a === b;
}

/**
 * The SSE path for one fixture.
 *
 * Relative, never absolute -- the same rule the snapshot path follows, and for the same reason:
 * a module that cannot name a host cannot be turned into outbound traffic by anything that
 * imports it. See `oddsTerminalSnapshotPath`.
 *
 * `mode=all` is what makes the market table unnecessary: it returns every market for the fixture,
 * so the filtering happens here rather than being guessed into the query.
 */
export function oddsTerminalStreamPath(
  plan: OddsTerminalReadPlan,
  fixtureId: string,
  // Display names here, not the ids the snapshot takes -- see `oddsTerminalStreamBooks`.
  books: string[] = oddsTerminalStreamBooks(plan.bookOrder)
): string {
  const params = new URLSearchParams();
  params.set("sport", plan.sport);
  params.set("league", plan.league);
  params.set("mode", "all");
  params.set("page", "1");
  params.set("fixture_id", fixtureId);
  for (const book of books) params.append("sportsbook", book);
  return `/api/stream?${params.toString()}`;
}

/**
 * Parses the raw SSE text into the entries it carried.
 *
 * Written against the wire format rather than using `EventSource`, because the relay needs to read
 * a bounded window of a stream that never ends on its own and then stop -- see `relay.ts`. The
 * format is simple and stable: blank-line-separated blocks of `field: value` lines, where the
 * `data:` line of an `event: odds` block is a JSON object whose `data` array holds the entries.
 *
 * Tolerant by design. A partial block at the end of a buffer (the stream was cut mid-message,
 * which is the normal way this read ends) is skipped rather than throwing.
 */
export function parseOddsTerminalStream(raw: string): OddsTerminalStreamEntry[] {
  const out: OddsTerminalStreamEntry[] = [];
  for (const block of raw.split(/\n\n+/)) {
    if (!block.includes("data:")) continue;
    // A block's `data:` may be split across several lines; SSE says to join them with newlines.
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown; data?: unknown };
      if (Array.isArray(parsed?.data)) out.push(...(parsed.data as OddsTerminalStreamEntry[]));
    } catch {
      // A truncated final block. Expected when the read is stopped mid-stream.
    }
  }
  return out;
}

/** The money actually resting behind a quote, where the book publishes it. */
function liquidityOf(entry: OddsTerminalStreamEntry): number | null {
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
 * Turns a fixture's stream entries into rows the matcher and verdict builder understand.
 *
 * Emits one row per (selection, side), exactly as every other source in this project does, so
 * nothing downstream can tell which source produced a row.
 *
 * Two things this gets from the stream that `/api/snapshot` could not give:
 *
 *  - **The side is stated.** `selection_line` is literally "over"/"under", so no side has to be
 *    recovered from a label like "Victor Bericoto Over 2.5". The snapshot parser had to guess.
 *  - **Real depth.** Exchange entries carry `limits.max` and a full `order_book`, so the modal's
 *    liquidity column has actual numbers behind it rather than nulls.
 */
export function normalizeOddsTerminalStream(
  entries: OddsTerminalStreamEntry[],
  plan: OddsTerminalReadPlan,
  fixture: OddsTerminalFixture,
  options: { atLine?: number | null } = {}
): ParseResult {
  try {
    if (!Array.isArray(entries)) {
      return { ok: false, reason: "the stream carried no entries", headers: [], rows: [] };
    }
    const fixtureId = str(fixture.id);
    const { home, away } = oddsTerminalFixtureTeams(fixture);
    const isGameMarket = plan.marketType === "MONEYLINE" || plan.marketType === "SPREAD";
    const atLine =
      plan.marketType === "MONEYLINE" || typeof options.atLine !== "number" ? null : options.atLine;

    const wanted = plan.requestedStatMarket;
    const marketsSeen = new Set<string>();

    // One book's two sides at one line, paired before either is usable: a de-vig needs both and
    // the main-line choice is made from both. Keyed on book + selection + line, with the parts
    // carried on the value rather than parsed back out of the key -- player and book names both
    // contain spaces and punctuation.
    interface Pair {
      sportsbook: string;
      selection: string;
      one: OddsTerminalStreamEntry | null;
      two: OddsTerminalStreamEntry | null;
    }
    const pairs = new Map<string, Pair>();

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (fixtureId !== null && str(entry.fixture_id) !== fixtureId) continue;

      const market = str(entry.market);
      if (market) marketsSeen.add(market);
      if (!isOddsTerminalMarketMatch(market, wanted)) continue;

      const sportsbook = str(entry.sportsbook);
      if (!sportsbook) continue;

      const selectionRaw = str(entry.selection) ?? str(entry.normalized_selection);
      if (!selectionRaw) continue;

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
      const pairKey = `${sportsbook}::${selection}::${points ?? "null"}`;
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

      bucket.one.push({
        bookKey,
        label: sportsbook,
        line: plan.marketType === "MONEYLINE" ? priceOne : (pointsOne ?? pointsTwo),
        price: priceOne,
        otherSidePrice: priceTwo,
        liquidity: one ? liquidityOf(one) : null,
      });
      bucket.two.push({
        bookKey,
        label: sportsbook,
        line: plan.marketType === "MONEYLINE" ? priceTwo : (pointsTwo ?? pointsOne),
        price: priceTwo,
        otherSidePrice: priceOne,
        liquidity: two ? liquidityOf(two) : null,
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
      // Names the markets that *were* on the stream, because the actionable failure here is almost
      // always a market spelled differently rather than a market that is missing.
      return {
        ok: false,
        reason:
          `Odds Terminal is not quoting "${wanted}" on this game. It is showing: ` +
          `${[...marketsSeen].slice(0, 8).join(", ")}${marketsSeen.size > 8 ? ", ..." : ""}`,
        headers: [],
        rows: [],
      };
    }

    return {
      ok: true,
      headers: [plan.sport, plan.league, wanted],
      rows,
      reason: rows.length === 0 ? "the stream carried no priced selections" : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "could not read the stream",
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
        // Real numbers here, unlike every other source in this project: the stream publishes each
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
    selectionName: isGameMarket ? sideName : selection || sideName,
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
      source: "odds-terminal-stream",
      sport: plan.sport,
      league: plan.league,
      market: plan.requestedStatMarket,
      fixtureId: str(fixture.id),
      selection,
      bookCount: bookLines.length,
    }),
  };
}
