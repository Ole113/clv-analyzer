import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMatchingRow,
  findOddsApiEvent,
  normalizeOddsApiEvent,
  oddsApiBookmakers,
  oddsApiOddsUrl,
  planOddsApiRead,
  resolveOddsApiMarket,
  ODDS_API_BOOKS,
  ODDS_API_MAX_BOOKMAKERS,
  type MarketType,
  type OddsApiReadPlan,
  type ParseResult,
} from "@clv/shared";
import { DEFAULT_BOOK_ORDER } from "../app-settings";
import { parseOddsTerminal } from "./support/odds-terminal-fixture";
import { buildClosingVerdict } from "../closing";

/**
 * The Odds API interpretation path, end to end.
 *
 * The fixture is shaped exactly as the published reference documents the per-event odds response,
 * and carries the structural traps that actually break a parser of this kind: one book quoting two
 * points for one player, a book pricing one side only, a fixed-payout DFS column, and an exchange
 * resting a quote nowhere near the market.
 *
 * A whole section is given to the thing this feature is *for*: that both sources, fed the same
 * market, are put through the identical arithmetic. If those assertions ever fail the two tabs have
 * started disagreeing for reasons that are ours rather than the sportsbooks'.
 */

const FIXTURES = join(__dirname, "../../../../shared/src/__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

function planFor(
  sport: string,
  statMarket: string,
  marketType: MarketType = "PLAYER_PROP"
): OddsApiReadPlan {
  const plan = planOddsApiRead({ sport, statMarket, marketType });
  if ("kind" in plan) throw new Error(`expected a plan, got ${plan.kind}: ${plan.reason}`);
  return plan;
}

function parse(plan: OddsApiReadPlan, options?: { atLine?: number | null }): ParseResult {
  const result = normalizeOddsApiEvent(fixture("odds-api-nfl-reception-yds"), plan, options);
  expect(result.ok).toBe(true);
  return result;
}

describe("market resolution", () => {
  it("maps the spellings the boards actually store", () => {
    expect(resolveOddsApiMarket("NFL", "Receiving Yards")).toEqual({
      ok: true,
      sportKey: "americanfootball_nfl",
      market: "player_reception_yds",
    });
    // The "Player " prefix is the one thing the two boards genuinely disagree about, and it is
    // absorbed by `marketFilterKey` rather than by listing every market twice.
    expect(resolveOddsApiMarket("NFL", "Player Receiving Yards")).toMatchObject({
      market: "player_reception_yds",
    });
    expect(resolveOddsApiMarket("college football", "Rushing Yards")).toMatchObject({
      sportKey: "americanfootball_ncaaf",
      market: "player_rush_yds",
    });
  });

  it("carries the exotics that used to come back unmapped", () => {
    const market = (sport: string, stat: string) => {
      const resolved = resolveOddsApiMarket(sport, stat);
      return resolved.ok ? resolved.market : `UNRESOLVED: ${resolved.detail}`;
    };
    expect(market("NFL", "Longest Reception")).toBe("player_reception_longest");
    expect(market("NFL", "Longest Rush")).toBe("player_rush_longest");
    expect(market("NFL", "Longest Completion")).toBe("player_pass_longest_completion");
    expect(market("NFL", "Solo Tackles")).toBe("player_solo_tackles");
    expect(market("NFL", "Tackles + Assists")).toBe("player_tackles_assists");
    expect(market("NFL", "Sacks")).toBe("player_sacks");
    expect(market("NFL", "PAT Made")).toBe("player_pats");
    expect(market("NFL", "Field Goals Made")).toBe("player_field_goals");
  });

  it("keeps a pitcher's strikeouts distinct from a batter's", () => {
    // `marketFilterKey` strips "Player " and deliberately not "Pitcher ", which is the whole reason
    // these two can be told apart at all.
    expect(resolveOddsApiMarket("MLB", "Pitcher Strikeouts")).toMatchObject({
      market: "pitcher_strikeouts",
    });
    expect(resolveOddsApiMarket("MLB", "Strikeouts")).toMatchObject({
      market: "batter_strikeouts",
    });
  });

  it("names game markets by their type, not by the board's prose", () => {
    expect(resolveOddsApiMarket("NFL", "Seattle Seahawks +9", "SPREAD")).toMatchObject({
      market: "spreads",
    });
    expect(resolveOddsApiMarket("NFL", "Moneyline", "MONEYLINE")).toMatchObject({ market: "h2h" });
    expect(resolveOddsApiMarket("NFL", "Game Total", "GAME_TOTAL")).toMatchObject({
      market: "totals",
    });
    expect(resolveOddsApiMarket("NFL", "Team Total", "GAME_TOTAL")).toMatchObject({
      market: "team_totals",
    });
  });

  it("appends period suffixes on the game markets that carry them", () => {
    expect(resolveOddsApiMarket("NFL", "1st Half Total Points", "GAME_TOTAL")).toMatchObject({
      market: "totals_h1",
    });
    expect(resolveOddsApiMarket("NBA", "1st Quarter Moneyline", "MONEYLINE")).toMatchObject({
      market: "h2h_q1",
    });
    expect(resolveOddsApiMarket("MLB", "First 5 Innings Total Runs", "GAME_TOTAL")).toMatchObject({
      market: "totals_1st_5_innings",
    });
  });

  it("refuses a period-qualified player prop rather than answering about the full game", () => {
    // This is the one that matters most. Our own vocabulary happily produces "1st Half Receiving
    // Yards" because PropProfessor's screen carries it; this API does not, and silently dropping
    // the qualifier would return a perfectly well-formed answer that is wrong by a whole game.
    const half = resolveOddsApiMarket("NFL", "1st Half Receiving Yards");
    expect(half.ok).toBe(false);
    if (half.ok) throw new Error("unreachable");
    expect(half.kind).toBe("noEquivalent");
    expect(half.detail).toMatch(/no 1st Half variant of this player prop/i);

    // The four that do exist are still allowed through.
    expect(resolveOddsApiMarket("NFL", "1st Quarter Passing Yards")).toMatchObject({
      market: "player_pass_yds_q1",
    });
    expect(resolveOddsApiMarket("NBA", "1st Quarter Points")).toMatchObject({
      market: "player_points_q1",
    });
    // ...and a 1st-quarter prop the API does NOT carry is still refused, rather than being let
    // through just because some `_q1` markets exist.
    expect(resolveOddsApiMarket("NFL", "1st Quarter Receiving Yards").ok).toBe(false);
  });

  it("says plainly that it cannot cover tennis or soccer", () => {
    // Not an alias gap. The API keys those per tournament/competition and our league vocabulary has
    // collapsed them, exactly as PropProfessor does -- so this is terminal and blameless, and must
    // not be reported as a missing mapping somebody is expected to go and add.
    for (const sport of ["ATP", "Tennis", "Soccer", "Germany - Bundesliga"]) {
      const resolved = resolveOddsApiMarket(sport, "Aces");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.kind).toBe("noEquivalent");
      expect(resolved.detail).toMatch(/tournament or competition/);
    }
  });

  it("keeps a DFS-only market terminal and blameless", () => {
    const resolved = resolveOddsApiMarket("NFL", "Fantasy Score");
    expect(resolved).toMatchObject({ ok: false, kind: "noEquivalent" });
  });

  it("stays loud about a market it simply has no alias for", () => {
    const resolved = resolveOddsApiMarket("NFL", "Punts Inside The 20");
    expect(resolved).toMatchObject({ ok: false, kind: "unmapped" });
  });
});

describe("request planning", () => {
  it("never asks for more than one credit's worth", () => {
    const plan = planFor("NFL", "Receiving Yards");
    expect(plan.market).not.toContain(",");
    expect(plan.bookmakers.length).toBe(ODDS_API_MAX_BOOKMAKERS);
  });

  it("spends the credit on the books this install ranked highest", () => {
    // The request book list is not a second, separate preference: it is the Settings book order,
    // intersected with what this source actually carries.
    const chosen = oddsApiBookmakers(DEFAULT_BOOK_ORDER).map((key) => ODDS_API_BOOKS[key]);
    expect(chosen).toContain("fanduel");
    expect(chosen).toContain("pinnacle");
    // Circa is the top of DEFAULT_BOOK_ORDER and this source does not carry it, so the ranking has
    // to skip it rather than waste a slot or fall over.
    expect(chosen).not.toContain("circa");

    // A user who has pushed a book to the top gets it, even though it sits low in the default list.
    const dabbleFirst = oddsApiBookmakers(["dabble", ...DEFAULT_BOOK_ORDER]);
    expect(dabbleFirst).toContain("dabble_us_dfs");
  });

  it("puts the key and the market in the URL and nothing else identifying", () => {
    const url = oddsApiOddsUrl(planFor("NFL", "Receiving Yards"), "evt123", "SECRET");
    expect(url).toContain("markets=player_reception_yds");
    expect(url).toContain("oddsFormat=american");
    expect(url).toContain("/events/evt123/odds");
    expect(url).toContain("apiKey=SECRET");
  });
});

describe("event resolution", () => {
  const events = [
    { id: "e1", home_team: "Atlanta Falcons", away_team: "Arizona Cardinals" },
    { id: "e2", home_team: "Los Angeles Rams", away_team: "San Francisco 49ers" },
  ];

  it("matches a matchup written either way round", () => {
    expect(
      findOddsApiEvent(events, { matchup: "Arizona Cardinals vs Atlanta Falcons", subjectTeam: null })
    ).toMatchObject({ id: "e1" });
    expect(
      findOddsApiEvent(events, { matchup: "Atlanta Falcons @ Arizona Cardinals", subjectTeam: null })
    ).toMatchObject({ id: "e1" });
  });

  it("tolerates the abbreviations the boards actually use", () => {
    // "LA Rams" / "SF 49ers" is exactly how one of these boards writes it, and the city is the part
    // that varies -- the nickname is what identifies the club.
    expect(findOddsApiEvent(events, { matchup: "LA Rams vs SF 49ers", subjectTeam: null })).toMatchObject({
      id: "e2",
    });
  });

  it("falls back to a game market's own team when there is no matchup", () => {
    expect(findOddsApiEvent(events, { matchup: null, subjectTeam: "Los Angeles Rams" })).toMatchObject({
      id: "e2",
    });
  });

  it("returns nothing rather than guessing", () => {
    // Returning the wrong event is far worse than returning none: the market parses perfectly and
    // describes a different game, which is indistinguishable downstream from a good read.
    expect(findOddsApiEvent(events, { matchup: "Chicago Bears vs Green Bay Packers", subjectTeam: null })).toBeNull();
    expect(findOddsApiEvent(events, { matchup: null, subjectTeam: null })).toBeNull();
    // One recognisable side is not an identification.
    expect(findOddsApiEvent(events, { matchup: "Atlanta Falcons vs Somebody Else", subjectTeam: null })).toBeNull();
  });
});

describe("response parsing", () => {
  const plan = planFor("NFL", "Receiving Yards");

  it("emits an OVER and an UNDER row per player", () => {
    const { rows } = parse(plan);
    const london = rows.filter((r) => r.player === "Drake London");
    expect(london.map((r) => r.side).sort()).toEqual(["OVER", "UNDER"]);
    expect(rows.some((r) => r.player === "Marvin Harrison Jr")).toBe(true);
    // Every row speaks the *pick's* market vocabulary, not the API's key, so the shared matcher
    // keeps working unchanged.
    expect(new Set(rows.map((r) => r.statMarket))).toEqual(new Set(["Receiving Yards"]));
  });

  it("collapses a book's alt line onto its real one", () => {
    // DraftKings quotes 62.5 and 70.5. 62.5 is where the rest of the field is, so that is its main
    // line -- the same consensus rule the PropProfessor parser uses, shared outright.
    const { rows } = parse(plan);
    const over = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    const dk = over.bookLines.find((b) => b.bookKey === "draftkings")!;
    expect(dk.line).toBe(62.5);
    expect(dk.price).toBe(-118);
    expect(dk.rawText).toContain("also quoted");
  });

  it("keeps a book that prices only one side", () => {
    // The line is a property of the market, not of one side of it. Caesars quotes no Under and is
    // still quoting 62.5 to an Under bettor.
    const { rows } = parse(plan);
    const under = rows.find((r) => r.player === "Drake London" && r.side === "UNDER")!;
    const caesars = under.bookLines.find((b) => b.bookKey === "caesars")!;
    expect(caesars.line).toBe(62.5);
    expect(caesars.price).toBeNull();
  });

  it("translates the API's book keys into this project's own", () => {
    const { rows } = parse(plan);
    const keys = rows[0].bookLines.map((b) => b.bookKey);
    // `williamhill_us` is Caesars and `prophetx` is prophet -- without the translation these would
    // be keys the book order, the allowlist and the logo map have never heard of.
    expect(keys).toContain("caesars");
    expect(keys).not.toContain("williamhill_us");
    // And a translated key still finds its icon.
    const caesars = rows[0].bookLines.find((b) => b.bookKey === "caesars")!;
    expect(caesars.logoUrl).toContain("caesars");
  });

  it("drops a quote that was never a serious price", () => {
    // Novig rests -1200 against a field at -114. Its *line* looks ordinary, so only the price gives
    // it away -- which is why `nearMarket` is checked at all.
    const { rows } = parse(plan);
    const over = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    expect(over.bookLines.some((b) => b.bookKey === "novig")).toBe(false);
  });

  it("answers what each book pays at a line the field has moved off", () => {
    const { rows } = parse(plan, { atLine: 70.5 });
    const over = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    const dk = over.bookLines.find((b) => b.bookKey === "draftkings")!;
    // Its own main line is untouched; the alt-line price sits beside it, never instead of it.
    expect(dk.line).toBe(62.5);
    expect(dk.priceAtLine).toBe(138);
    // A book not quoting that number at all says so with a null rather than its own line's price.
    expect(over.bookLines.find((b) => b.bookKey === "fanduel")!.priceAtLine).toBeNull();
  });

  it("de-vigs each book that priced both sides, and only those", () => {
    const { rows } = parse(plan);
    const over = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    const fanduel = over.bookLines.find((b) => b.bookKey === "fanduel")!;
    expect(fanduel.fairProbability).toBeGreaterThan(0.5);
    expect(fanduel.fairProbability).toBeLessThan(0.55);
    expect(over.bookLines.find((b) => b.bookKey === "caesars")!.fairProbability).toBeNull();
  });

  it("never throws on a malformed payload", () => {
    for (const bad of [null, 42, "nope", {}, { bookmakers: "no" }]) {
      const result = normalizeOddsApiEvent(bad, plan);
      expect(result.ok).toBe(false);
      expect(result.rows).toEqual([]);
    }
  });

  it("refuses to answer about a market it did not ask for", () => {
    const answered = normalizeOddsApiEvent(
      {
        id: "e1",
        home_team: "Atlanta Falcons",
        away_team: "Arizona Cardinals",
        bookmakers: [
          {
            key: "fanduel",
            title: "FanDuel",
            markets: [
              {
                key: "player_rush_yds",
                outcomes: [
                  { name: "Over", description: "Drake London", price: -110, point: 12.5 },
                  { name: "Under", description: "Drake London", price: -110, point: 12.5 },
                ],
              },
            ],
          },
        ],
      },
      plan
    );
    expect(answered.ok).toBe(false);
    expect(answered.reason).toMatch(/player_rush_yds/);
  });
});

describe("the verdict, which both sources share", () => {
  const plan = planFor("NFL", "Receiving Yards");

  function verdictFor(atLine: number | null = null) {
    const { rows } = parse(plan, { atLine });
    const row = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    return buildClosingVerdict("PLAYER_PROP", "OVER", atLine ?? 62.5, row, null, "ODDS_API", {
      lookup: true,
    });
  }

  it("averages the sportsbooks and excludes the pick'em column", () => {
    const verdict = verdictFor();
    const included = verdict.closeLines.filter((l) => l.includedInAverage).map((l) => l.bookKey);
    expect(included).toContain("fanduel");
    expect(included).toContain("draftkings");
    // PrizePicks prices a flat -119/-119 regardless of where the market is. That is a property of
    // its fixed payout, not a reading of the market, so it is shown and never averaged.
    expect(included).not.toContain("prizepicks");
    expect(verdict.closeLines.some((l) => l.bookKey === "prizepicks")).toBe(true);
    expect(verdict.avgClosingLine).toBe(62.5);
  });

  it("is filtered exactly like the PropProfessor path, never like the optimizer", () => {
    // ODDS_API must reach `isSportsbookForClose`, the allowlist. A denylist here would admit every
    // DFS app and derived column the feed might add later -- the same bug the screen path had.
    const { rows } = parse(plan);
    const row = rows.find((r) => r.player === "Drake London" && r.side === "OVER")!;
    const asOddsApi = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "ODDS_API", {
      lookup: true,
    });
    const asScreen = buildClosingVerdict("PLAYER_PROP", "OVER", 62.5, row, null, "PP_SCREEN", {
      lookup: true,
    });
    expect(asOddsApi.closeLines.map((l) => [l.bookKey, l.includedInAverage])).toEqual(
      asScreen.closeLines.map((l) => [l.bookKey, l.includedInAverage])
    );
    expect(asOddsApi.avgClosingLine).toBe(asScreen.avgClosingLine);
    expect(asOddsApi.closeFairProb).toBe(asScreen.closeFairProb);
  });

  it("finds the pick the same matcher finds on the other source", () => {
    const { rows } = parse(plan);
    const matched = findMatchingRow(rows, {
      marketType: "PLAYER_PROP",
      player: "Drake London",
      subjectTeam: null,
      matchup: "Arizona Cardinals vs Atlanta Falcons",
      statMarket: "Receiving Yards",
      side: "OVER",
      externalPropId: null,
    });
    expect(matched?.player).toBe("Drake London");
    expect(matched?.side).toBe("OVER");
  });

  it("produces the same row shape the other source does", () => {
    // Not a cosmetic check. `buildClosingVerdict`, `findMatchingRow` and both modals are written
    // against one shape, and the entire design rests on neither source needing a special case --
    // which is also why the Odds modal can put the two side by side and call them comparable.
    const { parsed: terminal } = parseOddsTerminal("Receptions");
    const { rows } = parse(plan);

    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(terminal.rows[0]).sort());
    expect(Object.keys(rows[0].bookLines[0]).sort()).toEqual(
      Object.keys(terminal.rows[0].bookLines[0]).sort()
    );
  });
});
