import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMatchingRow,
  normalizeScreenMarket,
  planScreenRead,
  resolveClosingMarket,
  PROPPROFESSOR_MARKETS,
  isSportsbookForClose,
  type ParseResult,
  type ScreenReadPlan,
} from "@clv/shared";
import { buildClosingVerdict } from "../closing";

/**
 * The interpretation path, end to end, against real captured responses from PropProfessor's odds
 * screen -- and, for the two NCAAF fixtures, against picks that are actually in the user's
 * database. Two of the captured rows are the user's own open bets, so these assert the exact
 * question the tool exists to answer rather than a synthetic stand-in.
 *
 * Everything here runs in Node with no browser. That is the payoff of the screen being a JSON
 * endpoint: unlike the DOM parsers, which are stringified into the page by executeScript and so
 * cannot import anything, this path is ordinary importable code.
 */

const FIXTURES = join(__dirname, "../../../../shared/src/__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `pp-screen-${name}.json`), "utf8"));
}

function planFor(sport: string, statMarket: string, marketType = "PLAYER_PROP" as const) {
  const plan = planScreenRead({ sport, statMarket, marketType });
  if ("kind" in plan) throw new Error(`expected a plan, got ${plan.kind}: ${plan.reason}`);
  return plan;
}

function parse(name: string, plan: ScreenReadPlan): ParseResult {
  const result = normalizeScreenMarket(fixture(name), plan);
  expect(result.ok).toBe(true);
  return result;
}

describe("market resolution", () => {
  it("maps the spellings that actually appear in the database", () => {
    // Every one of these is a real (sport, statMarket) pair stored on a bet. The three left-hand
    // spellings below are three different boards' names for two concepts.
    expect(resolveClosingMarket("NCAAF", "Rushing Yards")).toEqual({
      ok: true,
      market: "Player Rushing Yards",
      league: "NCAAF",
    });
    expect(resolveClosingMarket("NCAAF", "Receiving Yards")).toEqual({
      ok: true,
      market: "Player Receiving Yards",
      league: "NCAAF",
    });
    expect(resolveClosingMarket("NCAAF", "Player Receiving Yards")).toEqual({
      ok: true,
      market: "Player Receiving Yards",
      league: "NCAAF",
    });
    // PropProfessor has no ATP/WTA split, and spells breakpoints as one word.
    expect(resolveClosingMarket("ATP", "Aces")).toEqual({
      ok: true,
      market: "Player Aces",
      league: "Tennis",
    });
    expect(resolveClosingMarket("ATP", "Break Points Won")).toEqual({
      ok: true,
      market: "Player Breakpoints Won",
      league: "Tennis",
    });
  });

  it("separates 'no book prices this' from 'we have no alias yet'", () => {
    // Terminal and blameless -- must never burn a retry.
    expect(resolveClosingMarket("NFL", "Fantasy Score")).toMatchObject({ kind: "noEquivalent" });
    expect(resolveClosingMarket("NFL", "1st Quarter Passing Yards")).toMatchObject({
      kind: "noEquivalent",
    });
    // A gap in our table -- must stay loud so a line can be added. "Longest Completion" used to
    // stand here and no longer does: it is a market the screen carries, and it is now aliased
    // along with every other Player/Pitcher value in __fixtures__/pp-screen-vocabulary.json.
    expect(resolveClosingMarket("NFL", "Quarterback Rating")).toMatchObject({ kind: "unmapped" });
    expect(resolveClosingMarket("Cricket", "Runs")).toMatchObject({ kind: "unmapped" });
  });

  it("resolves a market whether or not the board prefixed it with 'Player'", () => {
    // The two boards genuinely disagree on this, and hand-maintaining both spellings per market is
    // what let "Player Points + Rebounds + Assists" come back unmapped while the bare spelling
    // resolved. Both now route through the same derived index.
    for (const spelling of ["Longest Reception", "Player Longest Reception"]) {
      expect(resolveClosingMarket("NFL", spelling)).toMatchObject({
        ok: true,
        market: "Player Longest Reception",
      });
    }
    expect(resolveClosingMarket("NBA", "Player Points + Rebounds + Assists")).toMatchObject({
      market: "Player Points + Rebounds + Assists",
    });
    // "Pitcher " is deliberately not stripped: a pitcher's strikeouts are not a batter's.
    expect(resolveClosingMarket("MLB", "Pitcher Strikeouts")).toMatchObject({
      market: "Pitcher Strikeouts",
    });
    expect(resolveClosingMarket("MLB", "Strikeouts")).toMatchObject({ market: "Player Strikeouts" });
  });

  it("names a game total after the league, unless the board named the total itself", () => {
    // Previously every GAME_TOTAL fell through to the player-prop table and came back unmapped.
    expect(resolveClosingMarket("NFL", "Game Total", "GAME_TOTAL")).toMatchObject({
      market: "Total Points",
    });
    expect(resolveClosingMarket("MLB", "Game Total", "GAME_TOTAL")).toMatchObject({
      market: "Total Runs",
    });
    expect(resolveClosingMarket("WTA", "Total Games", "GAME_TOTAL")).toMatchObject({
      market: "Total Games",
    });
    expect(resolveClosingMarket("NHL", "Game Total", "GAME_TOTAL")).toMatchObject({
      market: "Total Goals",
    });
    // A board that said which total it meant is taken at its word rather than flattened.
    expect(resolveClosingMarket("ATP", "Total Sets", "GAME_TOTAL")).toMatchObject({
      market: "Total Sets",
    });
    // Still terminal where the sport has no game total at all.
    expect(resolveClosingMarket("PGA", "Game Total", "GAME_TOTAL")).toMatchObject({
      kind: "unmapped",
    });
  });

  it("names a game market by its type, not by whatever prose the board rendered", () => {
    expect(planFor("NCAAF", "Seattle Seahawks +9", "SPREAD" as never).body.market).toBe(
      "Point Spread"
    );
    expect(planFor("ATP", "Alexander Zverev", "MONEYLINE" as never).body.market).toBe("Moneyline");
  });

  it("asks for the whole market rather than filtering by a name we may spell differently", () => {
    const plan = planFor("NCAAF", "Rushing Yards");
    expect(plan.url).toBe("https://backend.propprofessor.com/screen");
    expect(plan.body).toMatchObject({ participants: [], games: [], is_live: false });
  });
});

describe("Xavier Robinson -- a real stored bet", () => {
  // Bet cmtutzju2000arvd5hzfa58d1: NCAAF, Rushing Yards, UNDER 24.5, Oklahoma vs Michigan.
  const plan = planFor("NCAAF", "Rushing Yards");
  const target = {
    marketType: "PLAYER_PROP" as const,
    player: "Xavier Robinson",
    subjectTeam: null,
    statMarket: "Rushing Yards",
    side: "UNDER" as const,
    matchup: "Oklahoma vs Michigan",
    externalPropId: null,
  };

  it("finds the pick even though the fixture spells the fixture the other way round", () => {
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const match = findMatchingRow(rows, target);
    expect(match).not.toBeNull();
    expect(match!.player).toBe("Xavier Robinson");
    expect(match!.side).toBe("UNDER");
    // Stored as "Oklahoma vs Michigan"; PropProfessor has Michigan home, Oklahoma away.
    expect(match!.matchup).toBe("Oklahoma vs Michigan");
  });

  it("rebuilds one line per book instead of reading a single selection", () => {
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const match = findMatchingRow(rows, target)!;
    // The row carries 27 selections; a naive read of the default selection alone would see only
    // the ~10 books quoting exactly 21.5, not the full field of 18.
    expect(match.bookLines.length).toBe(18);
    // Every book resolves to exactly one line.
    const keys = match.bookLines.map((b) => b.bookKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of match.bookLines) expect(b.line).not.toBeNull();

    // Only 10 of those 18 books quote a price on the Under actually taken. They are kept anyway:
    // the line is a property of the market, not of one side, and the average is over lines.
    const priced = match.bookLines.filter((b) => b.price !== null);
    expect(priced.length).toBe(10);
    expect(match.bookLines.map((b) => b.bookKey)).toContain("draftkings");
  });

  it("produces a closing verdict in line units", () => {
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const match = findMatchingRow(rows, target)!;
    const verdict = buildClosingVerdict("PLAYER_PROP", "UNDER", 24.5, match, null, "PP_SCREEN");

    expect(verdict.status).toBe("CLOSED");
    // theScore 24.5, Hardrock 21.5, Rebet 20.5, Prop Builder 20.5, OnyxOdds 21.5, BoomFantasy 21.5,
    // DraftKings 21.5, SportZino 21.5, Fliff 21.5 -- 21.5 is the real consensus (10 books quote it,
    // more than any other line), which is why OnyxOdds and DraftKings land there and not on 24.5:
    // their own price at 24.5 happened to be more balanced than at 21.5, but "most balanced" isn't
    // "most agreed-upon", and mainLineByBook now prefers the latter whenever a book has it. Fanatics'
    // 49.5 is still dropped as an outlier; keeping it would give 25.9 and cut the measured edge by
    // more than half.
    expect(verdict.closingBookCount).toBe(9);
    expect(verdict.avgClosingLine).toBeCloseTo(21.61, 2);
    // Under: edge = taken - close. Took 24.5 into a market that closed near 21.6.
    expect(verdict.edge).toBeCloseTo(2.89, 2);
    expect(verdict.beatClv).toBe(true);
    expect(verdict.note).toMatch(/fanatics/i);
  });
});

describe("Johnathan Montague -- a real stored bet", () => {
  // Bet cmtu55z780000rvq5k3u99q6o: NCAAF, Player Receiving Yards, OVER 26.5.
  const plan = planFor("NCAAF", "Player Receiving Yards");
  const target = {
    marketType: "PLAYER_PROP" as const,
    player: "Johnathan Montague",
    subjectTeam: null,
    statMarket: "Player Receiving Yards",
    side: "OVER" as const,
    matchup: "Boston College vs. Rutgers",
    externalPropId: null,
  };

  it("grades an Over in the opposite direction from an Under", () => {
    const rows = parse("ncaaf-receiving-yards", plan).rows;
    const match = findMatchingRow(rows, target)!;
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 26.5, match, null, "PP_SCREEN");

    expect(verdict.status).toBe("CLOSED");
    // Over: edge = close - taken. Took 26.5 into a market that settled near 27.5.
    expect(verdict.edge!).toBeCloseTo(verdict.avgClosingLine! - 26.5, 5);
    expect(verdict.beatClv).toBe(true);
  });
});

describe("main-line reconstruction", () => {
  const plan = planFor("ATP", "Aces");

  it("keeps a book whose line is recorded only in the selection text", () => {
    // The trap: BetMGM's Tiafoe line sits under the selection key "null" with line1 null, and its
    // value appears nowhere but the label "Tiafoe Over 5.5". Skipping null keys drops a real
    // sportsbook out of the average entirely.
    const rows = parse("tennis-aces", plan).rows;
    const tiafoe = rows.find((r) => r.player === "Tiafoe" && r.side === "OVER")!;
    const betmgm = tiafoe.bookLines.find((b) => b.bookKey === "betmgm");
    expect(betmgm).toBeDefined();
    expect(betmgm!.line).toBe(5.5);
  });

  it("prefers a book's most balanced price as its real number", () => {
    const rows = parse("tennis-aces", plan).rows;
    const shelton = rows.find((r) => r.player === "Shelton" && r.side === "OVER")!;
    // OnyxOdds quotes both 19.5 and 14.5; whichever wins, the other is recorded rather than lost.
    const onyx = shelton.bookLines.find((b) => b.bookKey === "onyxodds")!;
    expect([19.5, 14.5]).toContain(onyx.line);
    expect(onyx.rawText).toMatch(/also quoted/);
  });

  it("matches a full stored name against the screen's bare surname", () => {
    // "Alexander Zverev" is how the pick was captured; the screen writes tennis players as
    // surnames only, so an exact-name test would fail to price every tennis pick ever taken.
    const rows = parse("tennis-aces", plan).rows;
    const match = findMatchingRow(rows, {
      marketType: "PLAYER_PROP",
      player: "Frances Tiafoe",
      subjectTeam: null,
      statMarket: "Aces",
      side: "OVER",
      matchup: "Shelton vs Tiafoe",
      externalPropId: null,
    });
    expect(match?.player).toBe("Tiafoe");
  });
});

describe("stray exchange orders", () => {
  const plan = planFor("NCAAF", "Rushing Yards");

  /** A one-player market where each book quotes a single selection at the given prices. */
  const market = (odds: Record<string, { odds1: number | null; odds2: number | null }>) => ({
    game_data: [
      {
        gameId: "NCAAF:GAME:A:B:1",
        start: "2026-09-12T16:00:00.000Z",
        league: "NCAAF",
        homeTeam: "A",
        awayTeam: "B",
        market: "Player Rushing Yards",
        participant: "Test Player",
        defaultKey: "21.5",
        selections: {
          "21.5": {
            selection1: "Test Player Over 21.5",
            selectionType1: "Over",
            line1: 21.5,
            selection2: "Test Player Under 21.5",
            selectionType2: "Under",
            line2: 21.5,
            odds: Object.fromEntries(
              Object.entries(odds).map(([book, o]) => [book, { book, ...o }])
            ),
          },
        },
      },
    ],
  });

  it("drops a book whose only price is nowhere near a real market", () => {
    // The line reads as a perfectly ordinary 21.5, so the consensus check downstream would never
    // flag it -- the giveaway is that nobody would ever take -1000 on it. One resting order.
    const result = normalizeScreenMarket(
      market({
        FanDuel: { odds1: -110, odds2: -110 },
        DraftKings: { odds1: -112, odds2: -108 },
        Novig: { odds1: -1000, odds2: null },
      }),
      plan
    );
    const over = result.rows.find((r) => r.side === "OVER")!;
    expect(over.bookLines.map((b) => b.bookKey).sort()).toEqual(["draftkings", "fanduel"]);
  });

  it("keeps an exchange that is quoting a normal price", () => {
    const result = normalizeScreenMarket(
      market({
        FanDuel: { odds1: -110, odds2: -110 },
        Novig: { odds1: -105, odds2: -105 },
      }),
      plan
    );
    const over = result.rows.find((r) => r.side === "OVER")!;
    expect(over.bookLines.map((b) => b.bookKey).sort()).toEqual(["fanduel", "novig"]);
  });

  it("leaves moneyline prices alone, where -1000 is an ordinary favourite", () => {
    const mlPlan = planFor("ATP", "Moneyline", "MONEYLINE" as never);
    const result = normalizeScreenMarket(
      {
        game_data: [
          {
            gameId: "Tennis:GAME:X:Y:1",
            start: "2026-09-12T16:00:00.000Z",
            league: "Tennis",
            homeTeam: "X",
            awayTeam: "Y",
            market: "Moneyline",
            participant: "",
            defaultKey: "null",
            selections: {
              null: {
                selection1: "X",
                selection2: "Y",
                selectionType1: null,
                selectionType2: null,
                line1: null,
                line2: null,
                odds: { BetMGM: { book: "BetMGM", odds1: -1000, odds2: 650 } },
              },
            },
          },
        ],
      },
      mlPlan
    );
    const row = result.rows.find((r) => r.subjectTeam === "X")!;
    expect(row.bookLines.find((b) => b.bookKey === "betmgm")?.line).toBe(-1000);
  });
});

describe("main-line consensus", () => {
  const plan = planFor("NCAAF", "Rushing Yards");

  const selection = (line: number, odds1: number, odds2: number, book: string) => ({
    selection1: `Test Player Over ${line}`,
    selectionType1: "Over",
    line1: line,
    selection2: `Test Player Under ${line}`,
    selectionType2: "Under",
    line2: line,
    odds: { [book]: { book, odds1, odds2 } },
  });

  it("prefers the line most books agree on over whichever line happens to price closest to even money", () => {
    // FanDuel and DraftKings both quote the real market at 21.5, at perfectly ordinary (not
    // perfectly balanced) prices. FanDuel also hangs an unrelated, much deeper alt line at 9.5,
    // priced dead even -- a bug that picked "most balanced" over "most agreed-upon" would read that
    // as FanDuel's main line and throw its real 21.5 quote away entirely.
    const result = normalizeScreenMarket(
      {
        game_data: [
          {
            gameId: "NCAAF:GAME:A:B:1",
            start: "2026-09-12T16:00:00.000Z",
            league: "NCAAF",
            homeTeam: "A",
            awayTeam: "B",
            market: "Player Rushing Yards",
            participant: "Test Player",
            defaultKey: "21.5",
            selections: {
              "21.5": {
                selection1: "Test Player Over 21.5",
                selectionType1: "Over",
                line1: 21.5,
                selection2: "Test Player Under 21.5",
                selectionType2: "Under",
                line2: 21.5,
                odds: {
                  FanDuel: { book: "FanDuel", odds1: -105, odds2: -115 },
                  DraftKings: { book: "DraftKings", odds1: -108, odds2: -112 },
                },
              },
              "9.5": selection(9.5, -110, -110, "FanDuel"),
            },
          },
        ],
      },
      plan
    );
    const over = result.rows.find((r) => r.side === "OVER")!;
    const fanduel = over.bookLines.find((b) => b.bookKey === "fanduel");
    expect(fanduel?.line).toBe(21.5);
    expect(fanduel?.price).toBe(-105);
  });
});

describe("de-vigged closing probability", () => {
  const plan = planFor("NCAAF", "Rushing Yards");
  const target = (side: "OVER" | "UNDER") => ({
    marketType: "PLAYER_PROP" as const,
    player: "Xavier Robinson",
    subjectTeam: null,
    statMarket: "Rushing Yards",
    side,
    matchup: "Oklahoma vs Michigan",
    externalPropId: null,
  });
  const verdictFor = (side: "OVER" | "UNDER", openFairProb: number | null = null) => {
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const match = findMatchingRow(rows, target(side))!;
    return buildClosingVerdict("PLAYER_PROP", side, 24.5, match, null, "PP_SCREEN", {
      openFairProb,
    });
  };

  it("de-vigs a book that quoted both sides", () => {
    // Hardrock hangs 21.5 at -110 on the Over against -115 on the Under. Raw those imply 52.38%
    // and 53.49% -- 105.87% in total, the hold. Renormalising gives the Over 0.5238/1.0587.
    const verdict = verdictFor("OVER");
    const hardrock = verdict.closeLines.find((l) => l.bookKey === "hardrock")!;
    expect(hardrock.fairProbability).toBeCloseTo(0.510121, 6);
    expect(verdict.closeFairProb).toBeCloseTo(0.502992, 6);
    // Five of the eighteen books quoted both sides at their main line (Prop Builder now among
    // them, admitted as a screen sportsbook), so the fair price is a consensus of five while the
    // line is a consensus of nine.
    expect(verdict.fairBookCount).toBe(5);
    expect(verdict.closingBookCount).toBe(9);
  });

  it("gives the two sides of one market probabilities that sum to 1", () => {
    // The strongest available check that the arithmetic is a de-vig rather than a rescaling: the
    // Over row and the Under row are built independently, from opposite prices, and never compare
    // notes -- so summing to exactly 1 is a property of the maths, not of shared state.
    const over = verdictFor("OVER").closeFairProb!;
    const under = verdictFor("UNDER").closeFairProb!;
    expect(over + under).toBeCloseTo(1, 6);
  });

  it("keeps a pick'em column out of the fair price", () => {
    // PrizePicks quotes -119 on both sides of its 20.5, which de-vigs to a flat 50%. That is a
    // property of the fixed payout, not a reading of the market, and averaging it in would drag
    // every fair price toward the middle. The allowlist already excludes it from the line average;
    // this asserts the fair price is taken over the same set rather than over every column.
    const verdict = verdictFor("OVER");
    const prizepicks = verdict.closeLines.find((l) => l.bookKey === "prizepicks")!;
    expect(prizepicks.fairProbability).toBeCloseTo(0.5, 6);
    expect(prizepicks.includedInAverage).toBe(false);
  });

  it("measures price movement the line cannot see", () => {
    // The point of the second metric. Took the pick when the market called it 52%; it closed at
    // 50.3%, so the price moved against it by 1.7 probability points.
    expect(verdictFor("OVER", 0.52).priceEdge).toBeCloseTo(-1.701, 3);
    // And null, not 0, when there is no open probability to compare against -- a one-ended
    // difference is not a difference.
    expect(verdictFor("OVER", null).priceEdge).toBeNull();
  });

  it("reports no fair price rather than a bad one when nobody quoted both sides", () => {
    const rows = parse("ncaaf-receiving-yards", planFor("NCAAF", "Player Receiving Yards")).rows;
    const row = rows[0];
    // Strip every opposite-side price by blanking each book's own -- a book with one price has no
    // margin to remove, so there is nothing to de-vig.
    const oneSided = { ...row, bookLines: row.bookLines.map((b) => ({ ...b, fairProbability: null })) };
    const verdict = buildClosingVerdict("PLAYER_PROP", "OVER", 26.5, oneSided, null, "PP_SCREEN");
    expect(verdict.closeFairProb).toBeNull();
    expect(verdict.fairBookCount).toBe(0);
    // The closing LINE is unaffected: the two averages are over different samples on purpose.
    expect(verdict.avgClosingLine).not.toBeNull();
  });
});

describe("captured liquidity", () => {
  const plan = planFor("ATP", "Moneyline", "MONEYLINE" as never);
  const rowFor = (team: string) =>
    parse("tennis-moneyline", plan).rows.find((r) => r.subjectTeam === team)!;

  it("reads the depth behind each quote off the screen response", () => {
    const row = rowFor("Butvilas");
    const byKey = new Map(row.bookLines.map((b) => [b.bookKey, b.liquidity]));
    // The exchanges publish real depth; the traditional sportsbooks report a flat 0.
    expect(byKey.get("polymarketus")).toBe(61709);
    expect(byKey.get("pinnacle")).toBe(1050);
    expect(byKey.get("fanduel")).toBe(0);
  });

  it("lets a deep book pull the average toward its number", () => {
    const row = rowFor("Tobon");
    const plainAvg = buildClosingVerdict("MONEYLINE", null, 260, row, null, "PP_SCREEN")
      .avgClosingLine!;
    const weighted = buildClosingVerdict("MONEYLINE", null, 260, row, null, "PP_SCREEN", {
      useLiquidityWeighting: true,
    }).avgClosingLine!;
    // Kalshi (+280 behind $2,426), PolymarketUS (+282 behind $1,028) and Pinnacle (+275 behind
    // $1,050) are all above the field; weighting by depth moves the close up toward them.
    expect(plainAvg).toBeCloseTo(255.65, 2);
    expect(weighted).toBeGreaterThan(plainAvg);
    expect(weighted).toBeCloseTo(261.0, 1);
    // Bounded, not dominated: the deepest book is 60x the next, and the close still lands inside
    // the field rather than on top of PolymarketUS's +282.
    expect(weighted).toBeLessThan(282);
  });

  it("averages normally when every book reports $0, which is the common case", () => {
    // The whole NCAAF fixture reports 0 depth throughout, so switching liquidity weighting on must
    // be a no-op there rather than quietly reshaping every player-prop close.
    const propPlan = planFor("NCAAF", "Rushing Yards");
    const match = findMatchingRow(parse("ncaaf-rushing-yards", propPlan).rows, {
      marketType: "PLAYER_PROP",
      player: "Xavier Robinson",
      subjectTeam: null,
      statMarket: "Rushing Yards",
      side: "UNDER",
      matchup: "Oklahoma vs Michigan",
      externalPropId: null,
    })!;
    const plain = buildClosingVerdict("PLAYER_PROP", "UNDER", 24.5, match, null, "PP_SCREEN");
    const weighted = buildClosingVerdict("PLAYER_PROP", "UNDER", 24.5, match, null, "PP_SCREEN", {
      useLiquidityWeighting: true,
    });
    expect(weighted.avgClosingLine).toBeCloseTo(plain.avgClosingLine!, 10);
    expect(weighted.closingBookCount).toBe(plain.closingBookCount);
  });
});

describe("exclusion audit trail", () => {
  it("records which books were dropped, not only a sentence about it", () => {
    const plan = planFor("NCAAF", "Rushing Yards");
    const match = findMatchingRow(parse("ncaaf-rushing-yards", plan).rows, {
      marketType: "PLAYER_PROP",
      player: "Xavier Robinson",
      subjectTeam: null,
      statMarket: "Rushing Yards",
      side: "UNDER",
      matchup: "Oklahoma vs Michigan",
      externalPropId: null,
    })!;
    const verdict = buildClosingVerdict("PLAYER_PROP", "UNDER", 24.5, match, null, "PP_SCREEN");
    // The same fact the note states in prose, in a form that can be counted across picks.
    expect(verdict.excludedBooks).toEqual(["fanatics"]);
    expect(verdict.note).toMatch(/fanatics/i);
  });
});

describe("moneyline", () => {
  const plan = planFor("ATP", "Moneyline", "MONEYLINE" as never);

  it("tracks the price as the line, since there is no number to move", () => {
    const rows = parse("tennis-moneyline", plan).rows;
    const row = rows.find((r) => r.subjectTeam === "Binda & Biryukov")!;
    expect(row.marketType).toBe("MONEYLINE");
    expect(row.side).toBeNull();
    for (const b of row.bookLines) expect(b.line).toBe(b.price);
  });
});

describe("book classification on the screen", () => {
  it("admits real sportsbooks and rejects everything the screen adds around them", () => {
    // Observed book columns in the captured screen data.
    const sportsbooks = ["fanduel", "draftkings", "betmgm", "bovada", "fanatics", "hardrock",
      "betrivers", "ballybet", "fliff", "rebet", "thescore", "polymarket",
      // Sweepstakes books, counted like Fliff and Rebet: a real two-sided market, not a
      // fixed-payout pick threshold.
      "sportzino", "onyxodds",
      // Fantasy apps that, unlike the rest below, quote real market-tracking odds on this screen
      // rather than a fixed payout vig -- see SCREEN_FANTASY_SPORTSBOOK_HINTS in books.ts.
      "boomfantasy", "propbuilder"];
    for (const key of sportsbooks) {
      expect(isSportsbookForClose(key, null, true), key).toBe(true);
    }

    const notSportsbooks = ["prizepicks", "underdog", "betr", "dabble", "sleeper", "parlayplay",
      "chalkboard", "draftkings6"];
    for (const key of notSportsbooks) {
      expect(isSportsbookForClose(key, null, true), key).toBe(false);
    }
  });

  it("rejects a derived no-vig column that the sportsbook allowlist would otherwise admit", () => {
    // "novig" is a real exchange in SPORTSBOOK_HINTS, and it is a substring of "novigodds".
    expect(isSportsbookForClose("novigodds", "No-Vig Odds", true)).toBe(false);
    expect(isSportsbookForClose("novig", "Novig", true)).toBe(true);
  });

  it("rejects an explicit alt-line column", () => {
    expect(isSportsbookForClose("draftkings6alt", "DraftKings6 (Alt)", true)).toBe(false);
    expect(isSportsbookForClose("betralt", "Betr (Alt)", true)).toBe(false);
  });
});

describe("matcher safety", () => {
  const plan = planFor("NCAAF", "Rushing Yards");

  it("refuses to guess between two different people who tie", () => {
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const over = rows.find((r) => r.side === "OVER")!;
    // Two distinct subjects, both reachable only by surname, both scoring identically.
    const twoPeople = [
      { ...over, player: "Robinson" },
      { ...over, rowIndex: 99, player: "Robinson", subjectTeam: "different" },
    ];
    expect(
      findMatchingRow(twoPeople, {
        marketType: "PLAYER_PROP",
        player: "Xavier Robinson",
        subjectTeam: null,
        statMarket: "Rushing Yards",
        side: "OVER",
        matchup: null,
        externalPropId: null,
      })
    ).toBeNull();
  });

  it("still resolves one pick offered at several lines", () => {
    // Alt boards list the same player/stat/side twice. That tie is not an ambiguity of identity,
    // so the previous behaviour of taking the top scorer must survive.
    const rows = parse("ncaaf-rushing-yards", plan).rows;
    const over = rows.find((r) => r.side === "OVER")!;
    const sameGuyTwice = [over, { ...over, rowIndex: 99, takenLine: 40.5 }];
    expect(
      findMatchingRow(sameGuyTwice, {
        marketType: "PLAYER_PROP",
        player: "Xavier Robinson",
        subjectTeam: null,
        statMarket: "Rushing Yards",
        side: "OVER",
        matchup: null,
        externalPropId: null,
      })
    ).not.toBeNull();
  });
});

/**
 * The alias table against PropProfessor's own market dropdown.
 *
 * This exists because "no PropProfessor market alias for X" kept being reported one market at a
 * time, fixed one market at a time, and then reported again for the next one. The vocabulary
 * fixture is the full list of markets the screen answers to, so coverage of it is checkable in one
 * go rather than discovered in production -- and a market PropProfessor adds later shows up here as
 * a failing test instead of as a silently unread closing line.
 */
describe("market alias coverage", () => {
  const vocabulary: { markets: Record<string, { value: string }[]> } = JSON.parse(
    readFileSync(join(FIXTURES, "pp-screen-vocabulary.json"), "utf8")
  );
  const league: Record<string, string> = {
    football: "NFL",
    basketball: "NBA",
    baseball: "MLB",
    NHL: "NHL",
    Tennis: "tennis",
    Soccer: "soccer",
    UFC: "UFC",
    PGA: "PGA",
  };

  it("resolves every player market the screen carries, in both board spellings", () => {
    const unmapped: string[] = [];
    for (const [sport, items] of Object.entries(vocabulary.markets)) {
      for (const { value } of items) {
        if (!/^(Player|Pitcher) /.test(value)) continue;
        // PropProfessor writes "Player Receiving Yards"; OddsJam writes "Receiving Yards". Both
        // reach the database, so both have to resolve to the same screen market.
        for (const spelling of [value, value.replace(/^Player /, "")]) {
          const resolved = resolveClosingMarket(league[sport], spelling);
          if (!resolved.ok || resolved.market !== value) {
            unmapped.push(`${spelling} -> ${resolved.ok ? resolved.market : resolved.detail}`);
          }
        }
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("points every alias at a market the screen actually answers to", () => {
    // The failure this catches for real: three-pointers were aliased to "Player Three Pointers
    // Made", which reads perfectly and is not a market -- the screen calls it "Player Threes Made".
    const known = new Set(
      Object.values(vocabulary.markets).flatMap((items) => items.map((i) => i.value))
    );
    const bogus: string[] = [];
    for (const [, market] of Object.entries(PROPPROFESSOR_MARKETS)) {
      if (!known.has(market)) bogus.push(market);
    }
    expect([...new Set(bogus)]).toEqual([]);
  });

  it("keeps a pitcher's stat distinct from a batter's of the same name", () => {
    // marketFilterKey strips "Player " but never "Pitcher ", and the derived index depends on it.
    expect(resolveClosingMarket("MLB", "Pitcher Hits Allowed")).toMatchObject({
      market: "Pitcher Hits Allowed",
    });
    expect(resolveClosingMarket("MLB", "Hits")).toMatchObject({ market: "Player Hits" });
  });
});
