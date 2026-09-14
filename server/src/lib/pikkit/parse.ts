/**
 * Turning one row of a Pikkit export into a bet and its legs.
 *
 * The hard part is `bet_info`, which is a single run-on string with no delimiters inside a leg:
 *
 *     Over 0.5 Cedric Mullins Total Bases NYM vs. TB
 *     Tyler Nubin over 2.5 Player Assists Dallas Cowboys @ New York Giants
 *     Elmer Rodriguez-Cruz U 4.5 Strikeouts Thrown New York Yankees @ Los Angeles Angels
 *
 * Player, market and matchup are all just words in a row, and where one ends and the next begins
 * differs per book -- the side and line move around, and on Dabble the market comes *after* the
 * player while on Courtside it comes after the line. Writing a regex per book was the obvious
 * first move and is the wrong one: seven regexes that each silently stop matching when a book
 * tweaks its wording, with no signal other than breakdowns quietly getting emptier.
 *
 * So the boundary is found from the one part of the string whose vocabulary is actually knowable:
 * the market (see markets.ts). Locate the longest known market phrase, and everything before it is
 * the player and everything after it is the matchup, regardless of which book wrote it. A leg
 * whose market is not in the table keeps its raw text and contributes to slip-level totals as
 * normal -- it simply does not appear in the leg-exposure breakdowns, which is the honest outcome
 * rather than a guess.
 */

import { lookupMarket, MAX_MARKET_TOKENS } from "./markets";

export interface ParsedLeg {
  legIndex: number;
  rawText: string;
  side: "OVER" | "UNDER" | null;
  line: number | null;
  player: string | null;
  market: string | null;
  marketKey: string | null;
  matchup: string | null;
}

export interface ParsedPikkitBet {
  externalId: string;
  sportsbook: string;
  betType: "STRAIGHT" | "PARLAY";
  result: "WIN" | "LOSS" | "VOID" | "PENDING";
  oddsDecimal: number;
  closingDecimal: number | null;
  pikkitEv: number | null;
  stake: number;
  profit: number;
  placedAt: Date;
  settledAt: Date | null;
  betInfo: string;
  isLive: boolean;
  sportsRaw: string;
  leaguesRaw: string;
  legCount: number;
  noRisk: boolean;
  legs: ParsedLeg[];
}

/** How the export spells "the pick was the higher side" across seven apps. */
const OVER_WORDS = new Set(["over", "higher", "o"]);
const UNDER_WORDS = new Set(["under", "lower", "u"]);

/** A bare number. Only ever read as a line when a side word sits next to it. */
const BARE_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
/**
 * A number that is a line on its own, with no side word: the signed or bracketed form a spread is
 * written in ("+39.5", "(-1.5)"). Deliberately narrower than BARE_NUMBER, because an unsigned bare
 * number appears inside team names ("SV 07 Elversberg", "Charlotte 49ers") and reading one of
 * those as the line would cut the leg in the wrong place.
 */
const STANDALONE_LINE = /^\(?([+-]\d+(?:\.\d+)?)\)?$/;

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[()]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

interface SideAndLine {
  side: "OVER" | "UNDER" | null;
  line: number | null;
  /** Index of the first token consumed, and of the first token after the span. */
  start: number;
  end: number;
}

/**
 * Find the side/line span, wherever the book chose to put it.
 *
 * Three shapes, in the order they are tried at each position: "Over 4.5" (most books), "48.5 Over"
 * (one Dabble variant), and a lone signed line with no side word at all (spreads and handicaps,
 * where the direction is carried by the sign).
 */
function findSideAndLine(tokens: string[]): SideAndLine | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const word = tokens[i].toLowerCase().replace(/[.,]$/, "");
    const next = tokens[i + 1];

    if ((OVER_WORDS.has(word) || UNDER_WORDS.has(word)) && next && BARE_NUMBER.test(next)) {
      return {
        side: OVER_WORDS.has(word) ? "OVER" : "UNDER",
        line: toNumber(next),
        start: i,
        end: i + 2,
      };
    }

    const nextWord = next?.toLowerCase().replace(/[.,]$/, "");
    if (BARE_NUMBER.test(tokens[i]) && nextWord && (OVER_WORDS.has(nextWord) || UNDER_WORDS.has(nextWord))) {
      return {
        side: OVER_WORDS.has(nextWord) ? "OVER" : "UNDER",
        line: toNumber(tokens[i]),
        start: i,
        end: i + 2,
      };
    }

    if (STANDALONE_LINE.test(tokens[i])) {
      return { side: null, line: toNumber(tokens[i]), start: i, end: i + 1 };
    }
  }
  return null;
}

interface FoundMarket {
  spelling: string;
  key: string;
  game: boolean;
  start: number;
  end: number;
}

/**
 * The longest known market phrase in `tokens`.
 *
 * Longest wins, and that is load-bearing rather than a tie-break preference: "Hits + Runs + RBIs"
 * contains both "Hits" and "RBIs", "Total Bases" contains "Total", and "Tackles + Assists"
 * contains both halves. Taking the first or the shortest match would file most multi-stat props
 * under one of their components and put the rest of the market name into the matchup.
 */
function findMarket(tokens: string[]): FoundMarket | null {
  for (let size = Math.min(MAX_MARKET_TOKENS, tokens.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const phrase = tokens.slice(start, start + size).join(" ");
      const def = lookupMarket(phrase);
      if (def) {
        return { spelling: phrase, key: def.key, game: def.game === true, start, end: start + size };
      }
    }
  }
  return null;
}

/** Underdog writes the side twice: once as Higher/Lower, then again as a literal "O/U" marker. */
function stripLeadingOverUnderMarker(tokens: string[]): string[] {
  return tokens[0]?.toUpperCase() === "O/U" ? tokens.slice(1) : tokens;
}

export function parseLeg(rawText: string, legIndex: number): ParsedLeg {
  const text = rawText.trim();
  const empty: ParsedLeg = {
    legIndex,
    rawText: text,
    side: null,
    line: null,
    player: null,
    market: null,
    marketKey: null,
    matchup: null,
  };
  if (!text) return empty;

  const tokens = text.split(/\s+/);
  const sideAndLine = findSideAndLine(tokens);

  // Everything before the side/line is the subject (a player on most books, a team on spreads);
  // everything after is still market + matchup, which findMarket separates.
  const prefix = sideAndLine ? tokens.slice(0, sideAndLine.start) : [];
  const rest = sideAndLine ? tokens.slice(sideAndLine.end) : tokens;

  const market = findMarket(rest);
  if (!market) {
    return {
      ...empty,
      side: sideAndLine?.side ?? null,
      line: sideAndLine?.line ?? null,
      player: prefix.length ? prefix.join(" ") : null,
    };
  }

  // The subject is whichever side of the market phrase actually holds it: before the line on
  // Courtside/Fliff/Novig, between the line and the market on Dabble/Underdog/Betr.
  const subjectTokens = prefix.length ? prefix : rest.slice(0, market.start);
  const matchupTokens = stripLeadingOverUnderMarker(rest.slice(market.end));

  return {
    legIndex,
    rawText: text,
    side: sideAndLine?.side ?? null,
    line: sideAndLine?.line ?? null,
    // A whole-game market has no player. The words in that position are a team name, and storing
    // one as a player would put "LIU Sharks" in the top-players table.
    player: market.game || subjectTokens.length === 0 ? null : subjectTokens.join(" "),
    market: market.spelling,
    marketKey: market.key,
    matchup: matchupTokens.length ? matchupTokens.join(" ") : null,
  };
}

/** Legs are joined by " | " -- the one delimiter the export does provide. */
export function parseLegs(betInfo: string): ParsedLeg[] {
  return betInfo
    .split(" | ")
    .map((leg) => leg.trim())
    .filter(Boolean)
    .map((leg, i) => parseLeg(leg, i));
}

const RESULTS: Record<string, ParsedPikkitBet["result"]> = {
  SETTLED_WIN: "WIN",
  SETTLED_LOSS: "LOSS",
  SETTLED_VOID: "VOID",
  SETTLED_PUSH: "VOID",
  SETTLED_CASHOUT: "WIN",
  PLACED: "PENDING",
  PENDING: "PENDING",
};

export class PikkitRowError extends Error {}

function requireNumber(raw: string, field: string): number {
  // Blank first: Number("") is 0, so an empty stake would otherwise import as a bet that risked
  // nothing, which is indistinguishable from a real 0 and silently wrong in every ROI below.
  if (!raw.trim()) throw new PikkitRowError(`${field} is empty`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new PikkitRowError(`${field} is not a number: "${raw}"`);
  return n;
}

function optionalNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function requireDate(raw: string, field: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new PikkitRowError(`${field} is not a date: "${raw}"`);
  return d;
}

/**
 * One CSV record -> one bet.
 *
 * Throws PikkitRowError rather than coercing: a row with an unreadable stake or an unrecognised
 * status is reported back to the import screen by row number, because the alternative is a bet
 * silently stored as 0 at stake or PENDING forever, which nothing downstream can detect.
 */
export function parsePikkitRow(row: Record<string, string>): ParsedPikkitBet {
  const externalId = (row.bet_id ?? "").trim();
  if (!externalId) throw new PikkitRowError("no bet_id");

  const status = (row.status ?? "").trim().toUpperCase();
  const result = RESULTS[status];
  if (!result) throw new PikkitRowError(`unrecognised status "${row.status}"`);

  const stake = requireNumber(row.amount ?? "", "amount");
  const profit = requireNumber(row.profit ?? "", "profit");
  const betInfo = row.bet_info ?? "";
  const legs = parseLegs(betInfo);

  // Prefer the ISO columns; the human-readable "09/13/2026 20:02:30 GMT" pair is a fallback for
  // older exports that may not carry them.
  const placedAt = requireDate(row.time_placed_iso || row.time_placed || "", "time_placed");
  const settledRaw = (row.time_settled_iso || row.time_settled || "").trim();
  const settledAt = settledRaw ? requireDate(settledRaw, "time_settled") : null;

  return {
    externalId,
    sportsbook: (row.sportsbook ?? "").trim() || "Unknown",
    betType: (row.type ?? "").trim().toLowerCase() === "parlay" ? "PARLAY" : "STRAIGHT",
    result,
    oddsDecimal: requireNumber(row.odds ?? "", "odds"),
    closingDecimal: optionalNumber(row.closing_line ?? ""),
    pikkitEv: optionalNumber(row.ev ?? ""),
    stake,
    profit,
    placedAt,
    settledAt,
    betInfo,
    isLive: /\blive\b/i.test(row.tags ?? ""),
    sportsRaw: (row.sports ?? "").trim(),
    leaguesRaw: (row.leagues ?? "").trim(),
    // The export's own leg count, which is what `bet_info` actually contains -- not `type`, since
    // a "parlay" of one leg and a straight are the same bet.
    legCount: Math.max(legs.length, 1),
    noRisk: result === "LOSS" && profit === 0,
    legs,
  };
}

/** The export's `sports` / `leagues` columns are " | "-joined sets, not one entry per leg. */
export function splitTagSet(raw: string): string[] {
  return raw
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);
}
