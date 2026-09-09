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

export type EspnPart = { category: string; label: string; transform?: "madeOf" };
export type MlbPart = { group: "batting" | "pitching"; field: string };

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

/**
 * Keys are normalized market names (see `normalizeName`), so "Player Receiving Yards",
 * "Receiving Yards" and "player receiving yards" all land on one entry.
 */
const MARKETS: Record<string, StatMapping> = {
  // --- football ---
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

  // --- basketball (single box-score category, so category is wildcarded) ---
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

  // --- baseball ---
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
  "player home runs": mlb({ group: "batting", field: "homeRuns" }),
  "player walks": mlb({ group: "batting", field: "baseOnBalls" }),
  "player stolen bases": mlb({ group: "batting", field: "stolenBases" }),
  outs: mlb({ group: "pitching", field: "outs" }),
  "pitcher outs": mlb({ group: "pitching", field: "outs" }),
  "player strikeouts": mlb({ group: "pitching", field: "strikeOuts" }),
  strikeouts: mlb({ group: "pitching", field: "strikeOuts" }),
  "player earned runs": mlb({ group: "pitching", field: "earnedRuns" }),
};

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

  const mapping = MARKETS[normalizeName(statMarket)];
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
