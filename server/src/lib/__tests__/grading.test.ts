import { describe, expect, it } from "vitest";
import { settle, hitRate } from "../grading/grade";
import {
  resolveMapping,
  parseStatCell,
  madeOf,
  sourceForSport,
  unsupportedReason,
} from "../grading/stat-map";

describe("settle", () => {
  it("grades an Over on either side of the line", () => {
    expect(settle("OVER", 62.5, 130)).toBe("WIN");
    expect(settle("OVER", 62.5, 40)).toBe("LOSS");
  });

  it("grades an Under on either side of the line", () => {
    expect(settle("UNDER", 6.5, 4)).toBe("WIN");
    expect(settle("UNDER", 6.5, 10)).toBe("LOSS");
  });

  it("returns PUSH when the stat lands exactly on a whole-number line", () => {
    expect(settle("OVER", 14, 14)).toBe("PUSH");
    expect(settle("UNDER", 14, 14)).toBe("PUSH");
    expect(settle("OVER", 2, 2)).toBe("PUSH");
  });

  it("never pushes on a half-point line", () => {
    expect(settle("OVER", 24.5, 24)).toBe("LOSS");
    expect(settle("OVER", 24.5, 25)).toBe("WIN");
  });

  it("treats float dust from summed composites as landing on the line", () => {
    // Composite markets sum several fields, so a total can come back as 7.500000000000001.
    // Real stats are whole or half numbers, so dust means "equal", not "a hair over".
    expect(settle("OVER", 7.5, 0.1 + 0.2 + 7.2)).toBe("PUSH");
    expect(settle("OVER", 0.1 + 0.2, 0.3)).toBe("PUSH");
    // A genuine one-unit difference still grades normally.
    expect(settle("OVER", 7.5, 8)).toBe("WIN");
    expect(settle("OVER", 7.5, 7)).toBe("LOSS");
  });
});

describe("hitRate", () => {
  it("excludes pushes and ungradeables from the denominator", () => {
    const rows = [
      { gradeResult: "WIN" },
      { gradeResult: "WIN" },
      { gradeResult: "LOSS" },
      { gradeResult: "PUSH" },
      { gradeResult: "UNGRADEABLE" },
      { gradeResult: null },
    ];
    expect(hitRate(rows)).toEqual({ wins: 2, losses: 1, pushes: 1, decided: 3, rate: 2 / 3 });
  });

  it("returns a null rate rather than 0 when nothing is decided", () => {
    expect(hitRate([{ gradeResult: "PUSH" }]).rate).toBeNull();
    expect(hitRate([]).rate).toBeNull();
  });
});

describe("made-of-attempted cells", () => {
  it("reads the made side of both separators used by ESPN", () => {
    expect(madeOf("13/20")).toBe(13); // NFL C/ATT
    expect(madeOf("2-3")).toBe(2); // NBA 3PT
    expect(madeOf("0-2")).toBe(0);
  });

  it("takes completions, never attempts", () => {
    expect(parseStatCell("13/20", "madeOf")).toBe(13);
    expect(parseStatCell("13/20")).toBeNull(); // would otherwise be a silent wrong number
  });

  it("treats empty and placeholder cells as no value", () => {
    expect(parseStatCell("")).toBeNull();
    expect(parseStatCell("--")).toBeNull();
    expect(parseStatCell(null)).toBeNull();
    expect(parseStatCell("130")).toBe(130);
  });
});

describe("resolveMapping", () => {
  it("maps football and basketball markets to ESPN box-score cells", () => {
    const rec = resolveMapping("NFL", "Player Receiving Yards");
    expect(rec.mapping).toEqual({ source: "espn", parts: [{ category: "receiving", label: "YDS" }] });

    const pra = resolveMapping("NBA", "Player Points Rebounds Assists");
    expect(pra.mapping?.parts).toHaveLength(3);
  });

  it("maps baseball composites to summed MLB fields", () => {
    const hrr = resolveMapping("MLB", "Hits + Runs + RBIs");
    expect(hrr.mapping).toEqual({
      source: "mlb",
      parts: [
        { group: "batting", field: "hits" },
        { group: "batting", field: "runs" },
        { group: "batting", field: "rbi" },
      ],
    });
  });

  it("is case and phrasing insensitive", () => {
    expect(resolveMapping("nfl", "receiving yards").mapping).toBeTruthy();
    expect(resolveMapping("NFL", "Player Receiving Yards").mapping).toBeTruthy();
  });

  it("refuses fantasy-score composites with a reason", () => {
    const r = resolveMapping("NFL", "Fantasy Score (PrizePicks)");
    expect(r.mapping).toBeNull();
    expect(r.reason).toMatch(/formula varies by book/i);
  });

  it("refuses CS2 and tennis with a reason naming the gap", () => {
    expect(resolveMapping("CS2", "1st 2 Maps Kills").reason).toMatch(/no free per-map stats/i);
    expect(resolveMapping("Tennis", "Player Aces").reason).toMatch(/tennis/i);
  });

  it("names an unmapped market rather than guessing at one", () => {
    const r = resolveMapping("NFL", "Player Longest Completion");
    expect(r.mapping).toBeNull();
    expect(r.reason).toContain("Player Longest Completion");
  });
});

describe("sourceForSport", () => {
  it("routes each supported sport", () => {
    expect(sourceForSport("NFL")).toBe("espn");
    expect(sourceForSport("NCAAF")).toBe("espn");
    expect(sourceForSport("NBA")).toBe("espn");
    expect(sourceForSport("MLB")).toBe("mlb");
  });

  it("returns null for sports with no wired source", () => {
    expect(sourceForSport("CS2")).toBeNull();
    expect(sourceForSport(null)).toBeNull();
    expect(unsupportedReason("CS2", "1st 2 Maps Kills")).toBeTruthy();
  });
});
