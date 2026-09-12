import { normalizeName } from "@clv/shared";

/**
 * Maps a board's `statMarket` string onto a concrete box-score extraction.
 *
 * Two rules keep this honest:
 *  - ESPN cells are looked up **by label name, never by column index**. NFL `receiving` is
 *    ['REC','YDS','AVG','TD','LONG','TGTS'] but NCAAF omits TGTS, so an index-based read would
 *    silently return a different stat for college games.
 *  - Anything not in this table resolves to UNGRADEABLE naming the exact string, so a gap shows
 *    up as work to do rather than a wrong number.
 */

/** `weight` defaults to 1; -1 subtracts the field, for stats with no direct box-score field of
 *  their own (assisted tackles is total tackles minus solo -- ESPN's defensive category has no
 *  "assisted" column of its own, only TOT and SOLO). */
export type EspnPart = { category: string; label: string; transform?: "madeOf"; weight?: 1 | -1 };
export type MlbPart = { group: "batting" | "pitching"; field: string; weight?: 1 | -1 };

export interface EspnMapping {
  source: "espn";
  /** Summed when a market is a composite (e.g. points + rebounds + assists). */
  parts: EspnPart[];
}

export interface MlbMapping {
  source: "mlb";
  parts: MlbPart[];
}

export type StatMapping = EspnMapping | MlbMapping;

/** ESPN sport paths, keyed by the sport string the boards use. */
export const ESPN_SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  ncaaf: "football/college-football",
  "college football": "football/college-football",
  nba: "basketball/nba",
  nhl: "hockey/nhl",
};

/** Sports we can settle automatically, and which source settles them. */
export function sourceForSport(sport: string | null): "espn" | "mlb" | null {
  const key = normalizeName(sport);
  if (!key) return null;
  if (key === "mlb") return "mlb";
  if (ESPN_SPORT_PATHS[key]) return "espn";
  return null;
}

const espn = (...parts: EspnPart[]): EspnMapping => ({ source: "espn", parts });
const mlb = (...parts: MlbPart[]): MlbMapping => ({ source: "mlb", parts });

const REC = (label: string): EspnPart => ({ category: "receiving", label });
const RUSH = (label: string): EspnPart => ({ category: "rushing", label });
const PASS = (label: string): EspnPart => ({ category: "passing", label });
const BOX = (label: string): EspnPart => ({ category: "*", label });
// NOT verified against a live ESPN response (this sandbox's egress to espn.com is blocked --
// 403/Access Denied on every attempt, same result via curl with a browser UA, so it isn't a
// WebFetch-specific block). Labels below are ESPN's long-standing, publicly documented NFL
// boxscore category shape: "defensive" -> [TOT, SOLO, SACKS, TFL, PD, QB HTS, TD] (TOT is the
// combined solo+assisted tackle count) and "interceptions" -> [INT, YDS, TD] (a defender's picks;
// distinct from the "passing" category's own INT label, which is a QB's picks thrown). Grade a
// real defensive prop once this ships -- a wrong label here fails safe (UNGRADEABLE with a clear
// "could not read" reason, per getPlayerValue in sources/espn.ts) rather than silently grading
// wrong, but it still needs a live check to confirm it actually works.
const DEF = (label: string): EspnPart => ({ category: "defensive", label });
const DEF_INT = (label: string): EspnPart => ({ category: "interceptions", label });
// Also NOT verified live (same network block). Category names ("skaters"/"goalies") are a common
// convention for ESPN's hockey boxscore, not confirmed for this endpoint specifically -- a wrong
// category name fails the same safe way as a wrong label (UNGRADEABLE, not a wrong number), it
// just fails for every NHL market at once rather than one at a time. Labels themselves come from
// the espn.com boxscore *page*'s own column headers (fetched live -- that host isn't blocked,
// only the api.espn.com JSON host is), which is good evidence for the labels but not proof the
// JSON's `labels` strings match the page's rendered header text exactly.
const SKATER = (label: string): EspnPart => ({ category: "skaters", label });
const GOALIE = (label: string): EspnPart => ({ category: "goalies", label });

/**
 * Keys are normalized market names (see `normalizeName`), scoped per sport group below --
 * "Player Receiving Yards", "Receiving Yards" and "player receiving yards" all land on one entry,
 * but the same normalized name can mean something completely different in another sport (NBA and
 * NHL both have a plain "Assists" market, for two unrelated stats). A single flat table keyed only
 * by market name would let one sport's entry silently shadow another's -- whichever sport's rows
 * happened to be written later in this file would win, and the loser would grade using the wrong
 * sport's field. Scoping by sport group first makes that collision structurally impossible.
 */
const FOOTBALL_MARKETS: Record<string, StatMapping> = {
  "player receiving yards": espn(REC("YDS")),
  "receiving yards": espn(REC("YDS")),
  "player receptions": espn(REC("REC")),
  receptions: espn(REC("REC")),
  "player rushing yards": espn(RUSH("YDS")),
  "rushing yards": espn(RUSH("YDS")),
  "player rushing attempts": espn(RUSH("CAR")),
  "rushing attempts": espn(RUSH("CAR")),
  "player passing yards": espn(PASS("YDS")),
  "passing yards": espn(PASS("YDS")),
  // C/ATT renders "13/20" -- completions must read the made side, never the attempts.
  "player passing completions": espn({ category: "passing", label: "C/ATT", transform: "madeOf" }),
  "passing completions": espn({ category: "passing", label: "C/ATT", transform: "madeOf" }),
  "player passing touchdowns": espn(PASS("TD")),
  "passing touchdowns": espn(PASS("TD")),
  "player rushing touchdowns": espn(RUSH("TD")),
  "player receiving touchdowns": espn(REC("TD")),
  "player kicking points": espn({ category: "kicking", label: "PTS" }),
  "kicking points": espn({ category: "kicking", label: "PTS" }),
  "player rushing receiving yards": espn(RUSH("YDS"), REC("YDS")),
  "rushing receiving yards": espn(RUSH("YDS"), REC("YDS")),
  // Five distinct markets confirmed in PropProfessor's own market dropdown (see
  // __fixtures__/pp-screen-vocabulary.json's "football" list, entries 56-60): "Tackles",
  // "Solo Tackles", "Tackles + Assists", "Tackles For Loss", "Tackles Assisted". "Tackles" and
  // "Tackles + Assists" are almost certainly the same underlying combined-tackle stat spelled two
  // ways (standard DFS convention: bare "Tackles" already means solo+assisted combined, which is
  // why "Solo Tackles" needs its own separate market) -- both map to ESPN's TOT field.
  "tackles assists": espn(DEF("TOT")),
  "player tackles assists": espn(DEF("TOT")),
  tackles: espn(DEF("TOT")),
  "player tackles": espn(DEF("TOT")),
  "solo tackles": espn(DEF("SOLO")),
  "player solo tackles": espn(DEF("SOLO")),
  // ESPN has no "assisted" field of its own -- derived as TOT minus SOLO.
  "tackles assisted": espn(DEF("TOT"), { ...DEF("SOLO"), weight: -1 }),
  "player tackles assisted": espn(DEF("TOT"), { ...DEF("SOLO"), weight: -1 }),
  sacks: espn(DEF("SACKS")),
  "player sacks": espn(DEF("SACKS")),
  "tackles for loss": espn(DEF("TFL")),
  "player tackles for loss": espn(DEF("TFL")),
  // Not seen in the captured PropProfessor vocabulary, but a common market name on OddsJam boards.
  "passes defended": espn(DEF("PD")),
  "player passes defended": espn(DEF("PD")),
  // A defender's own interceptions. PropProfessor's vocabulary has only this one interceptions
  // market (no separate "passing interceptions" for a QB's picks thrown), so this is what a QB
  // interception prop would also resolve to today -- it would come back UNGRADEABLE for a QB
  // (he won't appear in the "interceptions" category), not silently wrong, since a part that
  // matches no box-score row is treated as "player not found for this market" rather than zero.
  "player interceptions": espn(DEF_INT("INT")),
  interceptions: espn(DEF_INT("INT")),
};

// --- basketball (single box-score category, so category is wildcarded) ---
const BASKETBALL_MARKETS: Record<string, StatMapping> = {
  "player points": espn(BOX("PTS")),
  points: espn(BOX("PTS")),
  "player rebounds": espn(BOX("REB")),
  rebounds: espn(BOX("REB")),
  "player assists": espn(BOX("AST")),
  assists: espn(BOX("AST")),
  "player steals": espn(BOX("STL")),
  "player blocks": espn(BOX("BLK")),
  "player turnovers": espn(BOX("TO")),
  // 3PT renders "2-3" (made-attempted) -- same trap as C/ATT, different separator.
  "player threes": espn({ category: "*", label: "3PT", transform: "madeOf" }),
  "player 3 pointers made": espn({ category: "*", label: "3PT", transform: "madeOf" }),
  "player points rebounds": espn(BOX("PTS"), BOX("REB")),
  "player points assists": espn(BOX("PTS"), BOX("AST")),
  "player rebounds assists": espn(BOX("REB"), BOX("AST")),
  "player points rebounds assists": espn(BOX("PTS"), BOX("REB"), BOX("AST")),
  "player blocks steals": espn(BOX("BLK"), BOX("STL")),
};

// --- baseball ---
const BASEBALL_MARKETS: Record<string, StatMapping> = {
  "player hits": mlb({ group: "batting", field: "hits" }),
  hits: mlb({ group: "batting", field: "hits" }),
  "player runs": mlb({ group: "batting", field: "runs" }),
  runs: mlb({ group: "batting", field: "runs" }),
  "player rbis": mlb({ group: "batting", field: "rbi" }),
  rbis: mlb({ group: "batting", field: "rbi" }),
  "player hits runs rbis": mlb(
    { group: "batting", field: "hits" },
    { group: "batting", field: "runs" },
    { group: "batting", field: "rbi" }
  ),
  "hits runs rbis": mlb(
    { group: "batting", field: "hits" },
    { group: "batting", field: "runs" },
    { group: "batting", field: "rbi" }
  ),
  "player total bases": mlb({ group: "batting", field: "totalBases" }),
  "total bases": mlb({ group: "batting", field: "totalBases" }),
  // DFS-app shorthand for the same market.
  "player bases": mlb({ group: "batting", field: "totalBases" }),
  bases: mlb({ group: "batting", field: "totalBases" }),
  "player home runs": mlb({ group: "batting", field: "homeRuns" }),
  "player walks": mlb({ group: "batting", field: "baseOnBalls" }),
  "player stolen bases": mlb({ group: "batting", field: "stolenBases" }),
  "player runs rbis": mlb({ group: "batting", field: "runs" }, { group: "batting", field: "rbi" }),
  "runs rbis": mlb({ group: "batting", field: "runs" }, { group: "batting", field: "rbi" }),
  "player doubles": mlb({ group: "batting", field: "doubles" }),
  "player triples": mlb({ group: "batting", field: "triples" }),
  // MLB's API has no "singles" field of its own -- a single is a hit that wasn't an extra-base hit.
  "player singles": mlb(
    { group: "batting", field: "hits" },
    { group: "batting", field: "doubles", weight: -1 },
    { group: "batting", field: "triples", weight: -1 },
    { group: "batting", field: "homeRuns", weight: -1 }
  ),
  outs: mlb({ group: "pitching", field: "outs" }),
  "pitcher outs": mlb({ group: "pitching", field: "outs" }),
  "pitcher outs recorded": mlb({ group: "pitching", field: "outs" }),
  "player strikeouts": mlb({ group: "pitching", field: "strikeOuts" }),
  strikeouts: mlb({ group: "pitching", field: "strikeOuts" }),
  "pitcher strikeouts": mlb({ group: "pitching", field: "strikeOuts" }),
  "player earned runs": mlb({ group: "pitching", field: "earnedRuns" }),
  "pitcher earned runs allowed": mlb({ group: "pitching", field: "earnedRuns" }),
  "pitcher runs allowed": mlb({ group: "pitching", field: "runs" }),
  "pitcher hits allowed": mlb({ group: "pitching", field: "hits" }),
  "pitcher home runs allowed": mlb({ group: "pitching", field: "homeRuns" }),
  "pitcher walks allowed": mlb({ group: "pitching", field: "baseOnBalls" }),
  "pitcher pitches thrown": mlb({ group: "pitching", field: "numberOfPitches" }),
};

// --- hockey ---
// Confirmed against PropProfessor's own market dropdown (__fixtures__/pp-screen-vocabulary.json's
// "NHL" list): Goals, Assists, Points, Shots On Goal, Hits, Blocks, Blocked Shots, Faceoffs Won,
// Saves, Plus/Minus, Goals Allowed. "Points" has no direct box-score field -- it is the standard,
// unambiguous goals-plus-assists sum. "Power Play Points", "Time On Ice" (needs mm:ss parsing this
// table has no transform for) and "Shutout" (a derived boolean, not a field read) are left
// unmapped rather than guessed at.
const HOCKEY_MARKETS: Record<string, StatMapping> = {
  "player goals": espn(SKATER("G")),
  goals: espn(SKATER("G")),
  "player assists": espn(SKATER("A")),
  assists: espn(SKATER("A")),
  "player points": espn(SKATER("G"), SKATER("A")),
  points: espn(SKATER("G"), SKATER("A")),
  "player shots on goal": espn(SKATER("S")),
  "shots on goal": espn(SKATER("S")),
  "player hits": espn(SKATER("HT")),
  hits: espn(SKATER("HT")),
  "player blocks": espn(SKATER("BS")),
  blocks: espn(SKATER("BS")),
  "player blocked shots": espn(SKATER("BS")),
  "blocked shots": espn(SKATER("BS")),
  "player faceoffs won": espn(SKATER("FW")),
  "faceoffs won": espn(SKATER("FW")),
  "player plus minus": espn(SKATER("+/-")),
  "plus minus": espn(SKATER("+/-")),
  "player saves": espn(GOALIE("SV")),
  saves: espn(GOALIE("SV")),
  "player goals allowed": espn(GOALIE("GA")),
  "goals allowed": espn(GOALIE("GA")),
};

type SportGroup = "football" | "basketball" | "baseball" | "hockey";

const MARKETS_BY_GROUP: Record<SportGroup, Record<string, StatMapping>> = {
  football: FOOTBALL_MARKETS,
  basketball: BASKETBALL_MARKETS,
  baseball: BASEBALL_MARKETS,
  hockey: HOCKEY_MARKETS,
};

/**
 * Which sport group's market table a sport's picks resolve against. Derived from
 * `ESPN_SPORT_PATHS`'s own path prefix (e.g. "football/nfl" -> "football") rather than a second,
 * separately-maintained list of sport names, so adding a sport to one list can't silently leave it
 * missing from the other.
 */
function sportGroup(sport: string | null): SportGroup | null {
  const key = normalizeName(sport);
  if (!key) return null;
  if (key === "mlb") return "baseball";
  const path = ESPN_SPORT_PATHS[key];
  if (!path) return null;
  const prefix = path.split("/")[0];
  if (prefix === "football" || prefix === "basketball" || prefix === "hockey") return prefix;
  return null;
}

/** Markets we knowingly cannot settle, with the reason surfaced to the dashboard. */
export function unsupportedReason(sport: string | null, statMarket: string): string | null {
  const market = normalizeName(statMarket);
  const key = normalizeName(sport);

  // A full-game box score cannot answer a first-half line, and grading 280 full-game yards
  // against a 120.5 first-half line would look perfectly plausible while being wrong.
  const period = statMarket.match(/\b(1h|2h|first half|second half|q[1-4]|1st quarter|[1-4](?:st|nd|rd|th) quarter|1st inning|first \d+ innings|1st period)\b/i);
  if (period) {
    return `"${period[0]}" is a partial-game market; only full-game box scores are available, so grading it automatically would compare the wrong span.`;
  }

  if (market.includes("fantasy score")) {
    return "Fantasy-score props are composites whose scoring formula varies by book; grading them from a box score would risk silently wrong results.";
  }
  if (key === "cs2" || key === "csgo" || key === "lol" || key === "dota 2" || key === "valorant") {
    return `No free per-map stats source is wired up for ${sport}. Grade this one by hand if you want it counted.`;
  }
  if (key === "tennis" || key === "atp" || key === "wta") {
    return "Tennis has no free per-player stats source (ESPN exposes none), so aces and similar props cannot be settled automatically.";
  }
  return null;
}

export interface MappingLookup {
  mapping: StatMapping | null;
  reason: string | null;
}

/** Resolves a pick's market, or explains why it cannot be resolved. Never guesses. */
export function resolveMapping(sport: string | null, statMarket: string): MappingLookup {
  const unsupported = unsupportedReason(sport, statMarket);
  if (unsupported) return { mapping: null, reason: unsupported };

  const source = sourceForSport(sport);
  if (!source) {
    return { mapping: null, reason: `No stats source is configured for sport "${sport ?? "unknown"}".` };
  }

  const group = sportGroup(sport);
  const table = group ? MARKETS_BY_GROUP[group] : null;
  const mapping = table?.[normalizeName(statMarket)];
  if (!mapping) {
    return { mapping: null, reason: `Stat market "${statMarket}" is not mapped to a box-score field yet.` };
  }
  if (mapping.source !== source) {
    return {
      mapping: null,
      reason: `Market "${statMarket}" maps to the ${mapping.source} source but ${sport} is served by ${source}.`,
    };
  }
  return { mapping, reason: null };
}

/** Parses "13/20" or "2-3" (made-of-attempted) down to the made value. */
export function madeOf(raw: string): number | null {
  const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[/-]/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseStatCell(raw: string | null | undefined, transform?: "madeOf"): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text || text === "-" || text === "--") return null;
  if (transform === "madeOf") return madeOf(text);
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}
