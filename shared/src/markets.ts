/**
 * Translating a captured pick's market into the name a closing source will answer to.
 *
 * This layer did not exist before because the optimizer read never needed it: the board was already
 * open on the market in question, so whatever label it rendered was matched loosely by
 * `findMatchingRow`'s substring scoring. An odds screen inverts that -- the market name has to be
 * known *before* the request is sent, exactly, or nothing comes back at all.
 *
 * The live database already carries "Rushing Yards", "Receiving Yards" AND "Player Receiving Yards"
 * for what are only two concepts, because different boards spell them differently. PropProfessor
 * wants a third spelling again.
 *
 * Names verified against PropProfessor's own market dropdown, extracted from its page bundle
 * (see __fixtures__/pp-screen-vocabulary.json). Their `value` is what the API accepts; the `label`
 * shown in the dropdown is sometimes different ("Player Pass + Rush + Rec Touchdowns" is sent as
 * "Player Passing + Rushing + Receiving Touchdowns"), so this table holds values, never labels.
 */

import type { MarketType } from "./types";

/** Lowercased, punctuation-free, so "Break Points Won" and "breakpoints won" collapse together. */
export function normalizeMarketName(input: string | null | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Captured market name -> PropProfessor screen market.
 *
 * Keyed by `normalizeMarketName` output. Both the bare and the "player"-prefixed spellings are
 * listed for each concept because the two boards genuinely disagree and both reach the database.
 */
export const PROPPROFESSOR_MARKETS: Record<string, string> = {
  // --- football ---
  "rushing yards": "Player Rushing Yards",
  "player rushing yards": "Player Rushing Yards",
  "rushing attempts": "Player Rushing Attempts",
  "player rushing attempts": "Player Rushing Attempts",
  "rushing touchdowns": "Player Rushing Touchdowns",
  "player rushing touchdowns": "Player Rushing Touchdowns",
  "receiving yards": "Player Receiving Yards",
  "player receiving yards": "Player Receiving Yards",
  "receptions": "Player Receptions",
  "player receptions": "Player Receptions",
  "receiving targets": "Player Receiving Targets",
  "player receiving targets": "Player Receiving Targets",
  "receiving touchdowns": "Player Receiving Touchdowns",
  "player receiving touchdowns": "Player Receiving Touchdowns",
  "passing yards": "Player Passing Yards",
  "player passing yards": "Player Passing Yards",
  "passing touchdowns": "Player Passing Touchdowns",
  "player passing touchdowns": "Player Passing Touchdowns",
  "passing attempts": "Player Passing Attempts",
  "player passing attempts": "Player Passing Attempts",
  "passing completions": "Player Passing Completions",
  "player passing completions": "Player Passing Completions",
  "interceptions": "Player Interceptions",
  "player interceptions": "Player Interceptions",
  "rushing plus receiving yards": "Player Rushing + Receiving Yards",
  "player rushing plus receiving yards": "Player Rushing + Receiving Yards",
  "passing plus rushing yards": "Player Passing + Rushing Yards",
  "player passing plus rushing yards": "Player Passing + Rushing Yards",
  "tackles plus assists": "Player Tackles + Assists",
  "player tackles plus assists": "Player Tackles + Assists",
  "kicking points": "Player Kicking Points",
  "player kicking points": "Player Kicking Points",

  // --- basketball ---
  points: "Player Points",
  "player points": "Player Points",
  rebounds: "Player Rebounds",
  "player rebounds": "Player Rebounds",
  assists: "Player Assists",
  "player assists": "Player Assists",
  "points plus rebounds plus assists": "Player Points + Rebounds + Assists",
  "pts plus reb plus ast": "Player Points + Rebounds + Assists",
  "three pointers made": "Player Three Pointers Made",
  "player three pointers made": "Player Three Pointers Made",
  "3 pointers made": "Player Three Pointers Made",

  // --- tennis ---
  aces: "Player Aces",
  "player aces": "Player Aces",
  // PropProfessor spells this as one word; OddsJam uses two. This exact pair is why the table
  // cannot be a simple "Player " prefix rule.
  "break points won": "Player Breakpoints Won",
  "breakpoints won": "Player Breakpoints Won",
  "player breakpoints won": "Player Breakpoints Won",
  "aces plus double faults": "Player Aces + Double Faults",

  // --- baseball ---
  strikeouts: "Player Strikeouts",
  "player strikeouts": "Player Strikeouts",
  hits: "Player Hits",
  "player hits": "Player Hits",
  "total bases": "Player Total Bases",
  "player total bases": "Player Total Bases",
  runs: "Player Runs",
  "player runs": "Player Runs",
  rbis: "Player RBIs",
  "player rbis": "Player RBIs",
  "hits plus runs plus rbis": "Player Hits + Runs + RBIs",
  "player hits plus runs plus rbis": "Player Hits + Runs + RBIs",
  "runs plus rbis": "Player Runs + RBIs",
  "player runs plus rbis": "Player Runs + RBIs",
  singles: "Player Singles",
  "player singles": "Player Singles",
  doubles: "Player Doubles",
  "player doubles": "Player Doubles",
  triples: "Player Triples",
  "player triples": "Player Triples",
  "home runs": "Player Home Runs",
  "player home runs": "Player Home Runs",
  walks: "Player Walks",
  "player walks": "Player Walks",
  "stolen bases": "Player Stolen Bases",
  "player stolen bases": "Player Stolen Bases",
  // Bare "strikeouts" above is the batter's own; a pitcher's is only ever captured with the
  // "pitcher" prefix, so it needs no bare entry of its own.
  "pitcher strikeouts": "Pitcher Strikeouts",
  "earned runs allowed": "Pitcher Earned Runs Allowed",
  "pitcher earned runs allowed": "Pitcher Earned Runs Allowed",
  "runs allowed": "Pitcher Runs Allowed",
  "pitcher runs allowed": "Pitcher Runs Allowed",
  "hits allowed": "Pitcher Hits Allowed",
  "pitcher hits allowed": "Pitcher Hits Allowed",
  "home runs allowed": "Pitcher Home Runs Allowed",
  "pitcher home runs allowed": "Pitcher Home Runs Allowed",
  "walks allowed": "Pitcher Walks Allowed",
  "pitcher walks allowed": "Pitcher Walks Allowed",
  "outs recorded": "Pitcher Outs Recorded",
  "pitcher outs recorded": "Pitcher Outs Recorded",
  "pitches thrown": "Pitcher Pitches Thrown",
  "pitcher pitches thrown": "Pitcher Pitches Thrown",

  // --- hockey ---
  "shots on goal": "Player Shots On Goal",
  "player shots on goal": "Player Shots On Goal",
  saves: "Player Saves",
  "player saves": "Player Saves",

  // --- game markets ---
  moneyline: "Moneyline",
  "money line": "Moneyline",
  spread: "Point Spread",
  "point spread": "Point Spread",
};

/**
 * Markets no sportsbook prices, so no closing line can ever exist for them.
 *
 * These are not failures and must never burn retries: a PrizePicks "Fantasy Score" is a scoring
 * formula proprietary to that app, and a period-qualified prop ("1st Quarter Passing Yards") is not
 * carried on the screen even though the full-game version is. Seeded from the prose already in
 * the grading stat-map, which reached the same conclusions for the same reasons.
 */
export const NO_SPORTSBOOK_EQUIVALENT: RegExp[] = [
  /\bfantasy (score|points)\b/,
  /\bdfs\b/,
  /\bpick\s?em\b/,
  // Period-qualified markets: the screen carries full-game only.
  /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(quarter|qtr|half|period|inning|set)\b/,
  /\b(q1|q2|q3|q4|h1|h2|p1|p2|p3)\b/,
  /\bfirst\s+\d+\s+(innings|minutes)\b/,
];

/** League slug PropProfessor's screen expects, from whatever the capture called the sport. */
export const PROPPROFESSOR_LEAGUES: Record<string, string> = {
  nfl: "NFL",
  ncaaf: "NCAAF",
  "college football": "NCAAF",
  cfb: "NCAAF",
  nba: "NBA",
  ncaab: "NCAAB",
  "college basketball": "NCAAB",
  cbb: "NCAAB",
  wnba: "WNBA",
  nhl: "NHL",
  mlb: "MLB",
  npb: "NPB",
  kbo: "KBO",
  cfl: "CFL",
  pga: "PGA",
  golf: "PGA",
  ufc: "UFC",
  mma: "UFC",
  soccer: "Soccer",
  football: "Soccer", // only reachable when the capture said "football" meaning association football
  // PropProfessor has no ATP/WTA split -- both tours are one "Tennis" league.
  atp: "Tennis",
  wta: "Tennis",
  tennis: "Tennis",
  csgo: "CSGO",
  cs2: "CSGO",
  cod: "COD",
  lol: "LoL",
  valorant: "Valorant",
};

export type ResolvedMarket =
  | { ok: true; market: string; league: string }
  /** Knowably unpriceable. Terminal, and not a failure. */
  | { ok: false; kind: "noEquivalent"; detail: string }
  /** We simply have no mapping yet. Must stay loud so a line can be added to the table. */
  | { ok: false; kind: "unmapped"; detail: string };

/**
 * Decides what to ask PropProfessor's screen for, or why it cannot be asked.
 *
 * The three outcomes are deliberately distinct. Collapsing "no book prices this" into "we could not
 * find it" is the exact bug this redesign exists to fix, and collapsing "we have no alias yet" into
 * either one would hide the single maintenance task this design carries.
 */
export function resolveClosingMarket(
  sport: string | null,
  statMarket: string | null,
  marketType: MarketType = "PLAYER_PROP"
): ResolvedMarket {
  const stat = normalizeMarketName(statMarket);
  if (!stat) return { ok: false, kind: "unmapped", detail: "the pick has no market name" };

  if (NO_SPORTSBOOK_EQUIVALENT.some((re) => re.test(stat))) {
    return {
      ok: false,
      kind: "noEquivalent",
      detail: `"${statMarket}" is a DFS-only or period-qualified market that no sportsbook prices`,
    };
  }

  const league = PROPPROFESSOR_LEAGUES[normalizeMarketName(sport)];
  if (!league) {
    return { ok: false, kind: "unmapped", detail: `no PropProfessor league for sport "${sport}"` };
  }

  // Game markets are named by their type, not by whatever prose the board rendered ("Seattle
  // Seahawks +9" is a Point Spread however it is spelled).
  if (marketType === "MONEYLINE") return { ok: true, market: "Moneyline", league };
  if (marketType === "SPREAD") return { ok: true, market: "Point Spread", league };

  const market = PROPPROFESSOR_MARKETS[stat];
  if (!market) {
    return { ok: false, kind: "unmapped", detail: `no PropProfessor market alias for "${statMarket}"` };
  }
  return { ok: true, market, league };
}
