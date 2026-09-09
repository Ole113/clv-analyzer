import { describe, expect, it } from "vitest";
import { normalizeName } from "@clv/shared";
import {
  actualForTotal,
  marginForSpread,
  settleGameMarket,
  type SideScore,
} from "../grading/game-markets";

/** Stand-in for the real team matcher, with the same (boardName, variants) shape. */
const matches = (boardName: string, variants: string[]) => variants.includes(normalizeName(boardName));

const seahawks: SideScore = { variants: ["seattle seahawks", "seahawks"], score: 20 };
const rams: SideScore = { variants: ["los angeles rams", "rams"], score: 24 };

describe("game totals", () => {
  it("adds both sides", () => {
    expect(actualForTotal([seahawks, rams])).toBe(44);
  });

  it("settles over and under against the combined score", () => {
    expect(settleGameMarket("GAME_TOTAL", "OVER", 43.5, 44)).toBe("WIN");
    expect(settleGameMarket("GAME_TOTAL", "OVER", 44.5, 44)).toBe("LOSS");
    expect(settleGameMarket("GAME_TOTAL", "UNDER", 44.5, 44)).toBe("WIN");
    expect(settleGameMarket("GAME_TOTAL", "UNDER", 43.5, 44)).toBe("LOSS");
  });

  it("pushes when the total lands exactly on a whole-number line", () => {
    expect(settleGameMarket("GAME_TOTAL", "OVER", 44, 44)).toBe("PUSH");
    expect(settleGameMarket("GAME_TOTAL", "UNDER", 44, 44)).toBe("PUSH");
  });
});

describe("spreads", () => {
  it("computes the margin from the bet team's point of view", () => {
    // Seahawks lost 20-24
    expect(marginForSpread([seahawks, rams], "Seattle Seahawks", matches)).toBe(-4);
    expect(marginForSpread([seahawks, rams], "Los Angeles Rams", matches)).toBe(4);
  });

  it("refuses to guess when the team cannot be identified", () => {
    expect(marginForSpread([seahawks, rams], "Chicago Bears", matches)).toBeNull();
  });

  it("covers when the team loses by fewer points than the handicap", () => {
    // Seahawks +5.5, lost by 4 -> covered
    expect(settleGameMarket("SPREAD", null, 5.5, -4)).toBe("WIN");
    // Seahawks +3.5, lost by 4 -> did not cover
    expect(settleGameMarket("SPREAD", null, 3.5, -4)).toBe("LOSS");
  });

  it("handles favourites, where the margin must exceed the points laid", () => {
    // Rams -3.5, won by 4 -> covered
    expect(settleGameMarket("SPREAD", null, -3.5, 4)).toBe("WIN");
    // Rams -4.5, won by 4 -> did not cover
    expect(settleGameMarket("SPREAD", null, -4.5, 4)).toBe("LOSS");
  });

  it("pushes on a whole-number spread landing exactly", () => {
    // Seahawks +4, lost by exactly 4
    expect(settleGameMarket("SPREAD", null, 4, -4)).toBe("PUSH");
    // Rams -4, won by exactly 4
    expect(settleGameMarket("SPREAD", null, -4, 4)).toBe("PUSH");
  });
});
