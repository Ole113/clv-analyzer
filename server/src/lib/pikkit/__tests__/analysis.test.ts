import { describe, expect, it } from "vitest";
import {
  bandFor,
  breakdown,
  confidence,
  localParts,
  money,
  ODDS_BANDS,
  STAKE_BANDS,
  streaks,
  type AnalysisRow,
} from "../analysis";

/**
 * The aggregation rules, checked without a database.
 *
 * Almost everything that can be wrong here is wrong *quietly*: a void counted in the ROI
 * denominator, a mixed-league slip filed under one league, a bet landing in two odds bands, an
 * evening bet in Utah filed to the next day because the export stores UTC. Each of those produces
 * a chart that looks entirely reasonable and is not, so these are the cases worth pinning.
 */

let seq = 0;
function bet(over: Partial<AnalysisRow> = {}): AnalysisRow {
  seq += 1;
  return {
    id: `b${seq}`,
    externalId: `x${seq}`,
    sportsbook: "Novig",
    betType: "STRAIGHT",
    result: "WIN",
    oddsDecimal: 2,
    closingDecimal: null,
    pikkitEv: null,
    stake: 10,
    profit: 10,
    placedAt: new Date("2026-09-13T20:00:00Z"),
    betInfo: "",
    isLive: false,
    sportsRaw: "Baseball",
    leaguesRaw: "MLB",
    legCount: 1,
    noRisk: false,
    legs: [],
    ...over,
  };
}

describe("money", () => {
  it("excludes voids from turnover, profit and the win rate", () => {
    // A void returns the stake. Counting it as money risked would dilute the ROI by however many
    // games got postponed, and counting it as a decided bet would depress the win rate.
    const block = money([
      bet({ result: "WIN", stake: 10, profit: 10 }),
      bet({ result: "LOSS", stake: 10, profit: -10 }),
      bet({ result: "VOID", stake: 100, profit: 0 }),
    ]);
    expect(block.turnover).toBe(20);
    expect(block.decided).toBe(2);
    expect(block.voids).toBe(1);
    expect(block.winRate).toBe(0.5);
    expect(block.roi).toBe(0);
  });

  it("excludes pending bets from everything but their own count", () => {
    const block = money([
      bet({ result: "WIN", stake: 10, profit: 5 }),
      bet({ result: "PENDING", stake: 50, profit: 0 }),
    ]);
    expect(block.turnover).toBe(10);
    expect(block.pending).toBe(1);
    expect(block.roi).toBe(0.5);
  });

  it("counts a no-risk loss in the win rate but not against profit", () => {
    // A promo or free bet that lost: it is a loss for the record and cost nothing in money. Both
    // halves of that have to survive, so the win rate is not flattered and the ROI is not dented.
    const block = money([
      bet({ result: "WIN", stake: 10, profit: 10 }),
      bet({ result: "LOSS", stake: 10, profit: 0, noRisk: true }),
    ]);
    expect(block.winRate).toBe(0.5);
    expect(block.profit).toBe(10);
    expect(block.noRisk).toBe(1);
  });

  it("reports no ROI at all rather than zero when nothing has been risked", () => {
    expect(money([bet({ result: "PENDING" })]).roi).toBeNull();
    expect(money([]).roi).toBeNull();
  });
});

describe("breakdown", () => {
  it("counts a multi-league slip under every league it touches", () => {
    const rows = [
      bet({ leaguesRaw: "MLB | NFL", stake: 10, profit: 20 }),
      bet({ leaguesRaw: "MLB", result: "LOSS", stake: 10, profit: -10 }),
    ];
    const byLeague = breakdown(rows, (r) => r.leaguesRaw.split("|").map((s) => s.trim()));
    const mlb = byLeague.find((r) => r.key === "MLB");
    const nfl = byLeague.find((r) => r.key === "NFL");
    expect(mlb?.bets).toBe(2);
    expect(nfl?.bets).toBe(1);
    // The mixed slip contributes its whole stake to both, so the groups do not sum to the total.
    expect(mlb!.turnover + nfl!.turnover).toBe(30);
  });

  it("counts a slip once per group even when two legs share a market", () => {
    const rows = [
      bet({
        legs: [
          { side: "OVER", player: "A", marketKey: "hits" },
          { side: "OVER", player: "B", marketKey: "hits" },
        ],
      }),
    ];
    const byMarket = breakdown(rows, (r) => r.legs.map((l) => l.marketKey!) );
    expect(byMarket).toHaveLength(1);
    expect(byMarket[0].bets).toBe(1);
    expect(byMarket[0].turnover).toBe(10);
  });

  it("marks a thin group unreliable without hiding it", () => {
    const rows = [bet({ sportsbook: "Fliff" })];
    const [row] = breakdown(rows, (r) => [r.sportsbook]);
    expect(row.reliable).toBe(false);
    expect(row.bets).toBe(1);
  });

  it("keeps a fixed order where the buckets have a natural one", () => {
    const rows = [bet({ betType: "PARLAY" }), bet({ betType: "STRAIGHT" })];
    const out = breakdown(rows, (r) => [r.betType], undefined, ["STRAIGHT", "PARLAY"]);
    expect(out.map((r) => r.key)).toEqual(["STRAIGHT", "PARLAY"]);
  });
});

describe("local time", () => {
  it("files a late-evening bet on the day it was placed in Utah, not the UTC day", () => {
    // 03:50 UTC is 21:50 the previous evening in Denver. Bucketing on the raw timestamp would put
    // every Sunday-night NFL bet on Monday, and half the week's volume in the wrong column.
    expect(localParts(new Date("2026-09-14T03:50:46Z"))).toMatchObject({
      weekday: "Sun",
      hour: 21,
      dateKey: "2026-09-13",
      monthKey: "2026-09",
    });
  });

  it("uses mountain daylight time in summer and standard time in winter", () => {
    // Utah observes DST, so a fixed offset would be an hour out for half of any multi-year export.
    expect(localParts(new Date("2026-07-01T18:00:00Z")).hour).toBe(12); // MDT, UTC-6
    expect(localParts(new Date("2026-01-01T18:00:00Z")).hour).toBe(11); // MST, UTC-7
  });
});

describe("bands", () => {
  it("puts a value sitting exactly on an edge in the band above it", () => {
    expect(bandFor(ODDS_BANDS, 1.9)).toBe("1.9-2.1");
    expect(bandFor(ODDS_BANDS, 2.1)).toBe("2.1-3");
    expect(bandFor(STAKE_BANDS, 5)).toBe("$5-10");
  });

  it("puts every value in exactly one band", () => {
    for (const value of [0.01, 1.5, 1.9, 2, 2.1, 3, 5.99, 6, 9.9, 10, 487]) {
      const hits = ODDS_BANDS.filter(
        (b) => value >= b.from && (b.to === null || value < b.to)
      );
      expect(hits).toHaveLength(1);
    }
  });
});

describe("streaks", () => {
  const at = (iso: string, result: string) => bet({ result, placedAt: new Date(iso) });

  it("measures runs in the order the bets were placed", () => {
    const rows = [
      at("2026-09-03T00:00:00Z", "LOSS"),
      at("2026-09-01T00:00:00Z", "WIN"),
      at("2026-09-02T00:00:00Z", "WIN"),
      at("2026-09-04T00:00:00Z", "LOSS"),
      at("2026-09-05T00:00:00Z", "LOSS"),
    ];
    expect(streaks(rows)).toEqual({ longestWin: 2, longestLoss: 3, current: -3 });
  });

  it("does not let a void break a run", () => {
    // A postponed game is not a loss, so a run of wins either side of it is one run.
    const rows = [
      at("2026-09-01T00:00:00Z", "WIN"),
      at("2026-09-02T00:00:00Z", "VOID"),
      at("2026-09-03T00:00:00Z", "WIN"),
    ];
    expect(streaks(rows).longestWin).toBe(2);
  });
});

describe("confidence", () => {
  it("matches the ratio estimator worked by hand", () => {
    // A 10 win and a 30 loss: turnover 40, profit -20, so ROI is -50%. Each bet's residual against
    // that ROI is 15, giving a standard error of sqrt(450)/40 = 0.5303 and an ROI 0.943 standard
    // errors below break-even. Pinned numerically because the whole point of this block is that
    // the interval is the *stake-weighted* one -- the plain standard error of per-bet returns
    // would treat a 0.50 stake and a 50 stake as equally informative and report a far tighter one.
    const rows = [
      bet({ result: "WIN", stake: 10, profit: 10 }),
      bet({ result: "LOSS", stake: 30, profit: -30 }),
    ];
    const block = confidence(rows);
    expect(block.roi).toBeCloseTo(-0.5, 10);
    expect(block.z).toBeCloseTo(-0.9428, 4);
    expect(block.low).toBeCloseTo(-0.5 - 1.96 * 0.53033, 4);
    expect(block.high).toBeCloseTo(-0.5 + 1.96 * 0.53033, 4);
  });

  it("gives no interval at all below two decided bets", () => {
    expect(confidence([bet()])).toMatchObject({ low: null, high: null, z: null });
  });

  it("puts a flat record at zero standard errors from break-even", () => {
    const rows = [
      bet({ result: "WIN", stake: 10, profit: 10 }),
      bet({ result: "LOSS", stake: 10, profit: -10 }),
    ];
    expect(confidence(rows).z).toBeCloseTo(0, 10);
  });
});
