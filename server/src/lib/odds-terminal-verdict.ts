import {
  findMatchingRow,
  normalizeOddsTerminalOdds,
  planOddsTerminalRead,
  type ClosingReadOutcome,
  type ClosingSourceInfo,
  type ClosingWorkItem,
  type OddsTerminalFixture,
  type OddsTerminalOddsEntry,
  type OddsTerminalReadPlan,
  type ParsedRow,
} from "@clv/shared";
import { getAppSettings } from "./app-settings";

/**
 * Turns the Odds Terminal entries the extension read into a closing outcome.
 *
 * ## Read this before adding a fetch to this file
 *
 * **This module makes no outbound request and must never make one.** It is handed entries that
 * were already obtained, elsewhere, by the extension's background worker on the user's own signed-in
 * session, and its whole job is the part that happens *after* those bytes exist: parse, match, and
 * hand back an outcome.
 *
 * That is the architectural point of this source, not a layering accident. The shape that got the
 * PropProfessor account banned (2026-09) was a captured session token driving **server-initiated**
 * reads on a timer, firing whether or not the user was looking at anything. So the rule here is
 * structural: this server never learns the host, never holds a session, and cannot originate
 * contact even by accident, because the only thing it is ever given is a response body.
 * `oddsjam-automation-guard.test.ts` asserts it.
 *
 * ## Why it is not `odds-terminal-read.ts`
 *
 * The sibling module (`odds-api-read.ts`) owns its own transport: it holds a timeout, a cache and a
 * credential, and it returns an outcome. This one deliberately owns none of that -- there is
 * nothing to cache, nothing to authenticate (the user's own cookie jar did that, in their own
 * browser) and no timeout to set (the fetch already happened). Naming it `-read` would invite
 * exactly the code this comment forbids.
 */

/** What the extension collected, as it came off the wire. Untrusted, all of it. */
export interface RelayedOddsTerminalRead {
  /** The fixture the worker matched, echoed back so the parse can filter to it. */
  fixture: OddsTerminalFixture;
  /** The `odds[]` entries for the pick's market, already narrowed to it by the worker. */
  entries: OddsTerminalOddsEntry[];
  /** Market names the fixture carried, so "not quoting that" can say what it saw instead. */
  marketsSeen?: string[];
}

function sourceFor(plan: OddsTerminalReadPlan, fixtureId: string | null): ClosingSourceInfo {
  return {
    site: "ODDS_TERMINAL",
    // Deliberately not a URL -- see `ClosingSourceInfo.url`. An identifier that cannot be fetched
    // is the only kind this source is allowed to persist.
    url: `${plan.sport}/${fixtureId ?? "unknown"}`,
    league: plan.league,
    // Markets are matched by name here, so the pick's own market name is what gets recorded.
    // `ClosingSourceInfo.market` is provenance, not a key to fetch with.
    market: plan.requestedStatMarket,
  };
}

/** A few of the names the read did carry, so "not among them" can say what it saw. */
function sampleNamesFrom(rows: ParsedRow[], limit = 6): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.player ?? row.selectionName ?? null;
    if (name) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

/**
 * What the extension should ask for, so it never has to know this project's vocabulary.
 *
 * Made server-side and handed out rather than built in the worker, because the book ordering it
 * depends on is a user setting that lives in the database, and the market vocabulary it resolves
 * through is this project's own. The worker receives a finished plan and appends nothing.
 */
export async function planRelayRead(
  item: ClosingWorkItem & { gameStartIso?: string | null }
): Promise<OddsTerminalReadPlan | { kind: "noEquivalent" | "unmapped"; reason: string }> {
  const settings = await getAppSettings();
  return planOddsTerminalRead(item, { bookOrder: settings.bookOrder });
}

/**
 * The outcome for one pick, from the entries the extension collected.
 *
 * Returns the same `ClosingReadOutcome` every other source produces, so everything downstream --
 * `buildClosingVerdict`, the modal's rendering -- cannot tell which source produced it.
 */
export function readRelayedOdds(
  item: ClosingWorkItem,
  plan: OddsTerminalReadPlan,
  read: RelayedOddsTerminalRead
): ClosingReadOutcome {
  const source = sourceFor(plan, typeof read.fixture?.id === "string" ? read.fixture.id : null);
  const parsed = normalizeOddsTerminalOdds(read.entries, plan, read.fixture ?? {}, {
    atLine: item.takenLine,
    marketsSeen: read.marketsSeen,
  });

  if (!parsed.ok) {
    // The parser's reason names the markets the fixture DID carry, which is nearly always the
    // actionable detail -- a market spelled differently rather than one that is missing.
    return { kind: "READ_FAILED", reason: parsed.reason ?? "unreadable odds" };
  }
  if (parsed.rows.length === 0) {
    return { kind: "MARKET_NOT_OFFERED", source, availableMarkets: [] };
  }

  const row = findMatchingRow(parsed.rows, {
    marketType: item.marketType,
    statMarket: item.statMarket,
    player: item.player,
    subjectTeam: item.subjectTeam,
    matchup: item.matchup,
    side: item.side,
    externalPropId: item.externalPropId,
  });

  return row
    ? { kind: "MATCHED", row, source }
    : {
        kind: "SELECTION_ABSENT",
        source,
        candidateCount: parsed.rows.length,
        sampleNames: sampleNamesFrom(parsed.rows),
      };
}
