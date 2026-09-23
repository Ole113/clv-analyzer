import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMatchingRow,
  isOddsTerminalMarketMatch,
  normalizeOddsTerminalStream,
  oddsTerminalStreamPath,
  parseOddsTerminalStream,
  planOddsTerminalRead,
  type OddsTerminalFixture,
  type OddsTerminalStreamEntry,
} from "@clv/shared";
import { buildClosingVerdict } from "../closing";

/**
 * The `/api/stream` path, against a real captured response.
 *
 * The fixture is not synthetic: it is verbatim from a live signed-in capture of
 * `/api/stream?sport=baseball&league=mlb&mode=all&page=1&fixture_id=...&sportsbook=Kalshi`,
 * which is how the shapes asserted here are known rather than assumed. It carries the two things
 * that actually break a parser of this kind -- a market whose name contains `+` characters, and a
 * three-way market with a "Draw" selection belonging to neither side.
 */

const ENTRIES: OddsTerminalStreamEntry[] = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../shared/src/__fixtures__/odds-terminal-stream-mlb-kalshi.json"),
    "utf8"
  )
);

const FIXTURE: OddsTerminalFixture = {
  id: "202609237EDE0738",
  league: { id: "mlb", name: "MLB" },
  start_date: "2026-09-23T19:45:00Z",
  is_live: false,
  home_team_display: "San Francisco Giants",
  away_team_display: "Minnesota Twins",
};

function planFor(statMarket: string, marketType: "PLAYER_PROP" | "MONEYLINE" = "PLAYER_PROP") {
  const plan = planOddsTerminalRead({ sport: "MLB", statMarket, marketType });
  if ("kind" in plan) throw new Error(`expected a plan: ${plan.reason}`);
  return plan;
}

describe("matching a market by name instead of guessing its id", () => {
  it("matches the feed's own spelling to the board's", () => {
    // The whole reason the id table is gone. The feed's id for this market is
    // `player_hits_+_runs_+_rbis` -- literal plus signs in an identifier -- which is exactly the
    // kind of thing that cannot be guessed, and does not need to be.
    expect(isOddsTerminalMarketMatch("Player Hits + Runs + RBIs", "Hits + Runs + RBIs")).toBe(true);
    expect(isOddsTerminalMarketMatch("Player Hits + Runs + RBIs", "Player Hits + Runs + RBIs")).toBe(true);
    expect(isOddsTerminalMarketMatch("Player Strikeouts", "Strikeouts")).toBe(true);
    expect(isOddsTerminalMarketMatch("Player Receiving Yards", "Receiving Yards")).toBe(true);
  });

  it("reconciles the board synonyms normalization cannot reach", () => {
    expect(isOddsTerminalMarketMatch("Player Total Bases", "Bases")).toBe(true);
    expect(isOddsTerminalMarketMatch("Player Three Pointers Made", "3 Pointers Made")).toBe(true);
  });

  it("does not match two different markets", () => {
    expect(isOddsTerminalMarketMatch("Player Hits + Runs + RBIs", "Player Hits")).toBe(false);
    expect(isOddsTerminalMarketMatch("Player Strikeouts", "Player Walks")).toBe(false);
    expect(isOddsTerminalMarketMatch("", "Player Hits")).toBe(false);
  });
});

describe("the SSE wire format", () => {
  it("reads the entries out of event blocks", () => {
    const raw =
      'event: odds\nid: 1-1\nretry: 5000\ndata: {"type":"odds","data":[{"market":"A"},{"market":"B"}]}\n\n' +
      'event: odds\nid: 1-2\ndata: {"type":"odds","data":[{"market":"C"}]}\n\n';
    expect(parseOddsTerminalStream(raw).map((e) => e.market)).toEqual(["A", "B", "C"]);
  });

  it("skips a block truncated mid-message rather than throwing", () => {
    // The normal way this read ends: the relay stops reading a stream that never closes itself,
    // so the last block on the buffer is routinely a partial one.
    const raw =
      'event: odds\ndata: {"type":"odds","data":[{"market":"A"}]}\n\n' +
      'event: odds\ndata: {"type":"odds","data":[{"mark';
    expect(parseOddsTerminalStream(raw).map((e) => e.market)).toEqual(["A"]);
  });

  it("builds a relative stream path that names no host", () => {
    const path = oddsTerminalStreamPath(planFor("Hits + Runs + RBIs"), "FIXTURE1", ["Kalshi"]);
    expect(path.startsWith("/api/stream?")).toBe(true);
    expect(path).not.toMatch(/https?:|oddsterminal/i);
    expect(path).toContain("mode=all");
    expect(path).toContain("fixture_id=FIXTURE1");
    expect(path).toContain("league=mlb");
  });
});

describe("parsing the captured stream", () => {
  const plan = planFor("Hits + Runs + RBIs");

  it("emits an OVER and an UNDER row per player", () => {
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    const bericoto = rows.filter((r) => r.player === "Victor Bericoto");
    expect(bericoto.map((r) => r.side).sort()).toEqual(["OVER", "UNDER"]);
  });

  it("drops a quote that was never a real two-sided market", () => {
    // Bo Davidson's only selection in this capture is +592 / -933 -- implied probabilities of
    // about 0.15 and 0.90, both outside NEAR_MARKET_MIN_PROB. On an exchange that is a resting
    // order sitting on a deep alt line, not a price anyone is really offering, and the shared
    // `pickMainLines` rule excludes it. Asserted because it looks like a missing player until you
    // check the numbers: the capture has two players and this parser deliberately returns one.
    const players = [...new Set(normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows.map((r) => r.player))];
    expect(players).toEqual(["Victor Bericoto"]);
  });

  it("takes the side from selection_line rather than parsing a label", () => {
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    const over = rows.find((r) => r.player === "Victor Bericoto" && r.side === "OVER")!;
    const under = rows.find((r) => r.player === "Victor Bericoto" && r.side === "UNDER")!;
    expect(over.bookLines[0].price).toBe(306);
    expect(under.bookLines[0].price).toBe(-414);
    expect(over.bookLines[0].line).toBe(2.5);
  });

  it("carries the exchange depth the snapshot endpoint could not", () => {
    // New capability, not just a port: `limits.max` is real money behind the quote, which is what
    // the modal's liquidity column exists to show and what every other source leaves null.
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    const over = rows.find((r) => r.player === "Victor Bericoto" && r.side === "OVER")!;
    expect(over.bookLines[0].liquidity).toBe(47.52);
    expect(over.bookLines[0].bookKey).toBe("kalshi");
  });

  it("de-vigs from the two sides the stream gives it", () => {
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    const over = rows.find((r) => r.player === "Victor Bericoto" && r.side === "OVER")!;
    expect(over.bookLines[0].fairProbability).toBeGreaterThan(0);
    expect(over.bookLines[0].fairProbability).toBeLessThan(1);
  });

  it("ignores entries for a market that is not the pick's", () => {
    // The stream is `mode=all`, so it carries the whole fixture. Filtering is this parser's job,
    // and a leak would put moneyline prices under a player-prop heading.
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    for (const row of rows) expect(row.player).not.toBeNull();
    expect(rows.every((r) => r.player === "Victor Bericoto" || r.player === "Bo Davidson")).toBe(true);
  });

  it("drops a three-way market's Draw, which belongs to neither side", () => {
    // The capture's only moneyline is the 1st-5-innings 3-way, so it is asked for by that name.
    const mlPlan = planFor("1st 5 Innings Moneyline 3-Way", "MONEYLINE");
    const rows = normalizeOddsTerminalStream(ENTRIES, mlPlan, FIXTURE).rows;
    expect(rows.map((r) => r.subjectTeam).sort()).toEqual([
      "Minnesota Twins",
      "San Francisco Giants",
    ]);
    expect(rows.some((r) => r.selectionName === "Draw")).toBe(false);
  });

  it("does not answer a full-game question with a period market", () => {
    // "1st 5 Innings Moneyline 3-Way" is NOT the game moneyline, and matching the two would be the
    // worst class of bug this parser can have: a confidently wrong number under the right heading.
    // The capture contains no full-game moneyline, so asking for one must find nothing.
    const mlPlan = planFor("Moneyline", "MONEYLINE");
    expect(normalizeOddsTerminalStream(ENTRIES, mlPlan, FIXTURE).rows).toEqual([]);
    expect(isOddsTerminalMarketMatch("1st 5 Innings Moneyline 3-Way", "Moneyline")).toBe(false);
  });

  it("names the markets it did see when the pick's is absent", () => {
    // The actionable failure is nearly always a market spelled differently, so saying what WAS on
    // the stream beats "nothing found".
    const missing = planFor("Passing Yards");
    const result = normalizeOddsTerminalStream(ENTRIES, missing, FIXTURE);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Player Hits + Runs + RBIs");
  });

  it("keeps another fixture's entries out", () => {
    const foreign = ENTRIES.map((e) => ({ ...e, fixture_id: "SOMETHING-ELSE" }));
    expect(normalizeOddsTerminalStream(foreign, plan, FIXTURE).rows).toEqual([]);
  });

  it("returns a reason rather than throwing on rubbish", () => {
    for (const bad of [null, 42, "nope", {}]) {
      const result = normalizeOddsTerminalStream(bad as never, plan, FIXTURE);
      expect(result.ok).toBe(false);
    }
  });
});

describe("the row reaches the matcher and the verdict unchanged", () => {
  const plan = planFor("Hits + Runs + RBIs");

  it("is findable by the shared matcher on the pick's identity alone", () => {
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE).rows;
    const row = findMatchingRow(rows, {
      marketType: "PLAYER_PROP",
      statMarket: "Hits + Runs + RBIs",
      player: "Victor Bericoto",
      subjectTeam: null,
      matchup: "Minnesota Twins vs San Francisco Giants",
      side: "OVER",
      externalPropId: null,
    });
    expect(row?.player).toBe("Victor Bericoto");
  });

  it("is filtered and averaged identically to every other source", () => {
    const rows = normalizeOddsTerminalStream(ENTRIES, plan, FIXTURE, { atLine: 2.5 }).rows;
    const row = rows.find((r) => r.player === "Victor Bericoto" && r.side === "OVER")!;
    const asTerminal = buildClosingVerdict("PLAYER_PROP", "OVER", 2.5, row, null, "ODDS_TERMINAL", {
      lookup: true,
    });
    const asApi = buildClosingVerdict("PLAYER_PROP", "OVER", 2.5, row, null, "ODDS_API", {
      lookup: true,
    });
    expect(asTerminal.closeLines.map((l) => [l.bookKey, l.includedInAverage])).toEqual(
      asApi.closeLines.map((l) => [l.bookKey, l.includedInAverage])
    );
    expect(asTerminal.avgClosingLine).toBe(asApi.avgClosingLine);
  });
});
