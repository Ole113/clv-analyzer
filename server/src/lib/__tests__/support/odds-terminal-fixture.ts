import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planOddsTerminalRead,
  normalizeOddsTerminalOdds,
  type MarketType,
  type OddsTerminalFixture,
  type OddsTerminalOddsEntry,
  type OddsTerminalReadPlan,
  type ParseResult,
} from "@clv/shared";

/**
 * The committed Odds Terminal capture, and the two lines of setup every test around it needs.
 *
 * Shared rather than copied because three suites now read the same response for three different
 * reasons -- the parser's own tests, the book-logo map, and the price average -- and a fixture
 * loaded three slightly different ways is a fixture that can pass in one place and fail in another
 * for reasons that have nothing to do with the code under test.
 *
 * It is a real response: `GET /api/snapshot?...&fixture_id=<id>` with five sportsbooks, read on
 * 2026-09-24 from a signed-in browser, trimmed to the fields the parser reads and to four markets.
 * Nothing in the test suite fetches anything -- see `oddsjam-automation-guard.test.ts`.
 */

const FIXTURES = join(__dirname, "../../../../../shared/src/__fixtures__");

interface Capture {
  fixture: OddsTerminalFixture;
  odds: OddsTerminalOddsEntry[];
}

export function oddsTerminalCapture(): Capture {
  return JSON.parse(readFileSync(join(FIXTURES, "odds-terminal-nfl-fixture.json"), "utf8"));
}

export function oddsTerminalPlan(
  statMarket: string,
  marketType: MarketType = "PLAYER_PROP",
  sport = "NFL"
): OddsTerminalReadPlan {
  const plan = planOddsTerminalRead({ sport, statMarket, marketType });
  if ("kind" in plan) throw new Error(`expected a plannable read: ${plan.reason}`);
  return plan;
}

/** The capture parsed for one market, the way a lookup would parse it. */
export function parseOddsTerminal(
  statMarket: string,
  marketType: MarketType = "PLAYER_PROP",
  options: { atLine?: number | null; sport?: string } = {}
): { plan: OddsTerminalReadPlan; parsed: ParseResult } {
  const { fixture, odds } = oddsTerminalCapture();
  const plan = oddsTerminalPlan(statMarket, marketType, options.sport ?? "NFL");
  return {
    plan,
    parsed: normalizeOddsTerminalOdds(odds, plan, fixture, { atLine: options.atLine ?? null }),
  };
}
