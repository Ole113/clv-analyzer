import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMatchingRow,
  normalizeScreenMarket,
  planScreenRead,
  resolveClosingMarket,
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
    // A gap in our table -- must stay loud so a line can be added.
    expect(resolveClosingMarket("NFL", "Longest Completion")).toMatchObject({ kind: "unmapped" });
    expect(resolveClosingMarket("Cricket", "Runs")).toMatchObject({ kind: "unmapped" });
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
    // theScore 24.5, Hardrock 21.5, Rebet 20.5, OnyxOdds 24.5, DraftKings 24.5, SportZino 21.5,
    // Fliff 21.5. Fanatics' 49.5 is dropped as an outlier; keeping it would give 25.9 and cut the
    // measured edge by more than half.
    expect(verdict.closingBookCount).toBe(7);
    expect(verdict.avgClosingLine).toBeCloseTo(22.64, 2);
    // Under: edge = taken - close. Took 24.5 into a market that closed near 22.6.
    expect(verdict.edge).toBeCloseTo(1.86, 2);
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
      "sportzino", "onyxodds"];
    for (const key of sportsbooks) {
      expect(isSportsbookForClose(key, null, true), key).toBe(true);
    }

    const notSportsbooks = ["prizepicks", "underdog", "betr", "dabble", "sleeper", "parlayplay",
      "boomfantasy", "chalkboard", "propbuilder", "draftkings6"];
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
