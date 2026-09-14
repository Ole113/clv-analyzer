/**
 * What the seven books in a Pikkit export call the same market.
 *
 * The whole point of a cross-book history is questions like "how have my receiving-yards picks
 * done" -- and the export spells that market five different ways depending on which app the bet
 * was placed in:
 *
 *     Underdog     Receiving Yards
 *     Betr Picks   Receiving Yds
 *     Dabble       receiving-yards
 *     Fliff        RECEIVING YARDS
 *     Courtside    Player Receiving Yards
 *
 * `marketFilterKey` in @clv/shared already collapses case, punctuation and a leading "Player ",
 * which handles Fliff and Courtside. It cannot handle abbreviation -- "Yds" and "Yards" are just
 * different words -- so the remaining distance is covered by this table, which is a list of
 * spellings per canonical key rather than a per-book branch. A book that starts spelling a market
 * a sixth way is one entry here, not a new code path.
 *
 * The table doubles as the market *detector*: leg text arrives as one run-on string with no
 * delimiters ("Over 0.5 Cedric Mullins Total Bases NYM vs. TB"), so knowing the set of phrases
 * that can be a market is what locates the boundary between the player and the matchup. See
 * `findMarket` in parse.ts.
 */

import { normalizeMarketName } from "@clv/shared";

/**
 * A market with no player: team totals, spreads, moneylines.
 *
 * Tracked because the text before the market is a *team* on these ("LIU Sharks +39.5 Spread"),
 * not a player, and recording "LIU Sharks" in the player column would put teams into the
 * top-players breakdown.
 */
export interface MarketDef {
  key: string;
  label: string;
  game?: boolean;
  spellings: string[];
}

export const PIKKIT_MARKETS: MarketDef[] = [
  // --- football, passing ---
  { key: "passing-yards", label: "Passing Yards", spellings: ["Passing Yards", "Pass Yards", "Passing Yds", "Pass Yds", "passing-yards"] },
  { key: "passing-attempts", label: "Pass Attempts", spellings: ["Pass Attempts", "Passing Attempts", "Pass Atts", "Passing Atts", "passing-attempts"] },
  { key: "passing-completions", label: "Pass Completions", spellings: ["Pass Completions", "Passing Completions", "Pass Comps", "passing-completions"] },
  { key: "passing-touchdowns", label: "Passing TDs", spellings: ["Passing Touchdowns", "Pass TDs", "Passing TDs", "passing-touchdowns", "Player Passing Touchdowns"] },
  { key: "interceptions-thrown", label: "INTs Thrown", spellings: ["INTs Thrown", "Interceptions Thrown", "interceptions"] },

  // --- football, rushing and receiving ---
  { key: "rushing-yards", label: "Rushing Yards", spellings: ["Rushing Yards", "Rush Yards", "Rushing Yds", "Rush Yds", "rushing-yards"] },
  { key: "rushing-attempts", label: "Rush Attempts", spellings: ["Rush Attempts", "Rushing Attempts", "Rushing Atts", "Rush Atts", "rushing-attempts"] },
  { key: "receiving-yards", label: "Receiving Yards", spellings: ["Receiving Yards", "Receiving Yds", "Rec Yards", "Rec Yds", "receiving-yards"] },
  { key: "receptions", label: "Receptions", spellings: ["Receptions", "receptions", "Player Receptions"] },
  { key: "rush-rec-yards", label: "Rush + Rec Yards", spellings: ["Rush + Rec Yards", "Rush+Rec Yds", "Rushing + Receiving Yards", "rushing-yards + receiving-yards"] },
  { key: "pass-rush-yards", label: "Pass + Rush Yards", spellings: ["Pass + Rush Yards", "passing-yards + rushing-yards"] },
  { key: "longest-reception", label: "Longest Reception", spellings: ["Longest Reception", "longest-reception"] },
  { key: "longest-rush", label: "Longest Rush", spellings: ["Longest Rush", "longest-rush"] },
  { key: "anytime-touchdown", label: "Anytime TD", spellings: ["Anytime Touchdown", "anytime-touchdown", "Touchdowns", "Player Touchdowns"] },
  { key: "kicking-points", label: "Kicking Points", spellings: ["Kicking Points", "kicking-points"] },

  // --- football, defense ---
  { key: "tackles-assists", label: "Tackles + Assists", spellings: ["Tackles + Assists", "Player Tackles + Assists", "tackles + assists"] },
  { key: "tackles", label: "Tackles", spellings: ["Tackles", "tackles", "Player Tackles"] },
  { key: "assists", label: "Assists", spellings: ["Assists", "Player Assists"] },
  { key: "sacks", label: "Sacks", spellings: ["Sacks", "sacks", "Player Sacks"] },

  // --- baseball, hitting ---
  { key: "hits", label: "Hits", spellings: ["Hits", "hits", "Player Hits"] },
  { key: "total-bases", label: "Total Bases", spellings: ["Total Bases", "total-bases", "Bases", "Player Bases"] },
  { key: "hits-runs-rbis", label: "Hits + Runs + RBIs", spellings: ["Hits + Runs + RBIs", "Hits, Runs, RBIs", "Hits + Runs + Runs Batted In", "hits + runs + rbis", "Player Hits + Runs + RBIs"] },
  { key: "runs", label: "Runs", spellings: ["Runs", "runs"] },
  { key: "rbis", label: "RBIs", spellings: ["RBIs", "rbis", "Runs Batted In"] },
  { key: "singles", label: "Singles", spellings: ["Singles", "singles"] },
  { key: "home-runs", label: "Home Runs", spellings: ["Home Runs", "home-runs"] },
  { key: "stolen-bases", label: "Stolen Bases", spellings: ["Stolen Bases", "stolen-bases"] },

  // --- baseball, pitching ---
  { key: "strikeouts", label: "Strikeouts", spellings: ["Strikeouts", "strikeouts", "Strikeouts Thrown", "Pitching Strikeouts", "Player Strikeouts"] },
  { key: "outs-recorded", label: "Outs Recorded", spellings: ["Outs Recorded", "Pitching Outs", "Total Outs Pitched", "Outs", "outs"] },
  { key: "hits-allowed", label: "Hits Allowed", spellings: ["Hits Allowed", "hits-allowed", "Pitching Hits Allowed"] },
  { key: "earned-runs", label: "Earned Runs", spellings: ["Earned Runs Allowed", "Earned Runs", "earned-runs"] },
  { key: "walks", label: "Walks", spellings: ["Walks", "walks", "Pitching Walks", "Walks Allowed"] },

  // --- basketball ---
  { key: "points", label: "Points", spellings: ["Points", "points", "Player Points"] },
  { key: "rebounds", label: "Rebounds", spellings: ["Rebounds", "rebounds", "Player Rebounds"] },
  { key: "points-rebounds-assists", label: "Pts + Rebs + Asts", spellings: ["Pts + Rebs + Asts", "Points + Rebounds + Assists", "PRA"] },
  { key: "points-rebounds", label: "Points + Rebounds", spellings: ["Points + Rebounds", "Pts + Rebs"] },
  { key: "points-assists", label: "Points + Assists", spellings: ["Points + Assists", "Pts + Asts"] },
  { key: "rebounds-assists", label: "Rebounds + Assists", spellings: ["Rebounds + Assists", "AST+REB", "Asts + Rebs"] },

  // --- tennis ---
  { key: "games-played", label: "Games", spellings: ["Games Played", "Total Games", "total-games"] },
  { key: "aces", label: "Aces", spellings: ["Aces", "aces"] },

  // --- soccer ---
  { key: "goals-assists", label: "Goals + Assists", spellings: ["Goals + Assists"] },
  { key: "goals", label: "Goals", spellings: ["Goals", "goals"] },
  { key: "shots-on-target", label: "Shots on Target", spellings: ["Shots on Target", "shots-on-target"] },

  // --- esports ---
  { key: "kills-maps-1-2", label: "Kills (Maps 1+2)", spellings: ["Kills on Maps 1+2"] },
  { key: "headshots-maps-1-2", label: "Headshots (Maps 1+2)", spellings: ["Headshots on Maps 1+2"] },
  { key: "kills", label: "Kills", spellings: ["Kills", "kills"] },

  // --- whole-game markets: no player, so the text before them is a team ---
  { key: "spread", label: "Spread", game: true, spellings: ["Spread", "Handicap", "Handicap (incl. overtime)", "Point Spread", "Games - Point Spread"] },
  { key: "moneyline", label: "Moneyline", game: true, spellings: ["Moneyline", "Money Line"] },
  { key: "game-total", label: "Game Total", game: true, spellings: ["Total", "Total (incl. overtime)", "Total Points", "Total Runs", "Total hits (incl. extra innings)", "Total Goals"] },
  { key: "corner-handicap", label: "Corner Handicap", game: true, spellings: ["Corner handicap", "Corners Handicap"] },
  { key: "odd-even", label: "Odd / Even", game: true, spellings: ["Total Score Odd/Even", "Odd/Even"] },

  // --- period-qualified markets ---
  // Kept as keys of their own rather than folded into the full-game market above. A first-half
  // moneyline and a full-game moneyline are different bets with different prices, and averaging
  // them together would report a hit rate for a market nobody actually bet.
  { key: "1h-moneyline", label: "1st Half Moneyline", game: true, spellings: ["1st Half Moneyline", "1H Moneyline"] },
  { key: "1h-spread", label: "1st Half Spread", game: true, spellings: ["1st Half Goal Spread", "1st Half Spread"] },
  { key: "1h-corner-handicap", label: "1st Half Corner Handicap", game: true, spellings: ["1st half - corner handicap"] },
  { key: "1st-inning-total", label: "1st Inning Total", game: true, spellings: ["1st Inning Total", "1st Inning Total Runs"] },
  { key: "2nd-set-moneyline", label: "2nd Set Moneyline", game: true, spellings: ["2nd Set Moneyline"] },
  { key: "1q-receiving-yards", label: "1Q Receiving Yards", spellings: ["1Q Rec Yards", "1Q Receiving Yards"] },
];

/** Normalized spelling -> definition. Built once; every spelling above must be unique. */
const BY_SPELLING = new Map<string, MarketDef>();
for (const def of PIKKIT_MARKETS) {
  for (const spelling of def.spellings) {
    BY_SPELLING.set(normalizeMarketName(spelling), def);
  }
}

const BY_KEY = new Map(PIKKIT_MARKETS.map((d) => [d.key, d]));

/** The longest market phrase, in tokens -- the window size `findMarket` has to scan up to. */
export const MAX_MARKET_TOKENS = Math.max(
  ...PIKKIT_MARKETS.flatMap((d) => d.spellings.map((s) => s.split(/\s+/).length))
);

export function lookupMarket(phrase: string): MarketDef | null {
  return BY_SPELLING.get(normalizeMarketName(phrase)) ?? null;
}

/** Display label for a canonical key. Unknown keys are shown as they were stored. */
export function marketLabel(key: string | null): string {
  if (!key) return "Unparsed";
  return BY_KEY.get(key)?.label ?? key;
}
