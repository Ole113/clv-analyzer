import {
  findMatchingRow,
  findOddsTerminalFixture,
  normalizeOddsTerminalStream,
  oddsTerminalStreamPath,
  planOddsTerminalRead,
  type ClosingReadOutcome,
  type ClosingSourceInfo,
  type ClosingWorkItem,
  type OddsTerminalFixture,
  type OddsTerminalReadPlan,
  type OddsTerminalStreamEntry,
  type ParsedRow,
} from "@clv/shared";
import { getAppSettings } from "./app-settings";

/**
 * Turns a relayed Odds Terminal snapshot into a closing outcome.
 *
 * ## Read this before adding a fetch to this file
 *
 * **This module makes no outbound request and must never make one.** It is handed bytes that were
 * already obtained, elsewhere, by a content script running inside a tab the user's own click
 * opened, and its whole job is the part that happens *after* those bytes exist: resolve the
 * fixture, parse the flat odds array, match the pick's row.
 *
 * That is the entire architectural point of the Odds Terminal source. The shape that got the
 * PropProfessor account banned (2026-09) was a captured session token driving **server-initiated**
 * reads on a timer, firing whether or not the user was looking at anything. So the rule here is
 * structural rather than a matter of discipline: the server never learns the host, never holds a
 * session, and cannot originate contact even by accident, because the only thing it is ever given
 * is a response body. `oddsjam-automation-guard.test.ts` asserts it.
 *
 * ## Why it is not `odds-terminal-read.ts`
 *
 * The sibling modules (`pp-screen-read.ts`, `odds-api-read.ts`) own their own transport: they hold
 * a timeout, a cache and a credential, and they return an outcome. This one deliberately owns none
 * of that -- there is nothing to cache (the relay's tab is the cache), nothing to authenticate
 * (the user's own cookie jar did that, in their own browser) and no timeout to set (the fetch
 * already happened). Naming it `-read` would invite exactly the code this comment forbids.
 */

/**
 * What the relay collected, as it came off the wire.
 *
 * Two hops, because the feed needs two: the snapshot names the fixture, the stream prices it.
 */
export interface RelayedSnapshot {
  /** The parsed JSON body of `/api/snapshot`. Untouched, and treated as untrusted input. */
  body: unknown;
}

export interface RelayedStream {
  /** The `data[]` entries collected off `/api/stream`. Untrusted. */
  entries: OddsTerminalStreamEntry[];
  /** The fixture the relay was told to stream, echoed back so the parse can filter on it. */
  fixture: OddsTerminalFixture;
}

function sourceFor(plan: OddsTerminalReadPlan, fixtureId: string | null): ClosingSourceInfo {
  return {
    site: "ODDS_TERMINAL",
    // Deliberately not a URL -- see `ClosingSourceInfo.url`. An identifier that cannot be fetched
    // is the only kind this source is allowed to persist.
    url: `${plan.sport}/${fixtureId ?? "unknown"}`,
    league: plan.league,
    // A prop has no feed-side id (it is matched by name), so the pick's own market name is what
    // gets recorded. `ClosingSourceInfo.market` is provenance, not a key to fetch with.
    market: plan.marketId ?? plan.requestedStatMarket,
  };
}

/** A few of the names the snapshot did carry, so "not among them" can say what it saw. */
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
 * What the relay should ask for, so the extension never has to know the vocabulary.
 *
 * The plan is made server-side and handed out rather than built in the content script, because the
 * book ordering it depends on is a user setting that lives in the database. The relay receives a
 * finished path and appends nothing of its own.
 */
export async function planRelayRead(
  item: ClosingWorkItem
): Promise<OddsTerminalReadPlan | { kind: "noEquivalent" | "unmapped"; reason: string }> {
  const settings = await getAppSettings();
  return planOddsTerminalRead(item, { bookOrder: settings.bookOrder });
}

/** What the relay should do next, once the fixture is known. */
export interface ResolvedFixture {
  fixture: OddsTerminalFixture;
  /** Relative, always. The relay appends nothing of its own. */
  streamPath: string;
}

/**
 * Finds the pick's fixture in a snapshot the relay already fetched.
 *
 * This is all the snapshot is for now. The stream will not hand out a `fixture_id`, and it will
 * not answer without one, so the fixture has to be identified here first -- from team names, with
 * the same fail-closed discipline as everywhere else: ambiguity is a refusal, never a guess.
 */
export function resolveRelayedFixture(
  item: ClosingWorkItem,
  plan: OddsTerminalReadPlan,
  snapshot: RelayedSnapshot
): ResolvedFixture | ClosingReadOutcome {
  const body = snapshot.body;
  if (!body || typeof body !== "object") {
    return { kind: "READ_FAILED", reason: "Odds Terminal returned something that was not a snapshot." };
  }
  const fixtures = (body as { fixtures?: unknown }).fixtures;
  if (!Array.isArray(fixtures)) {
    return { kind: "READ_FAILED", reason: "The Odds Terminal snapshot carried no fixtures." };
  }

  const fixture = findOddsTerminalFixture(fixtures as OddsTerminalFixture[], plan, {
    matchup: item.matchup,
    subjectTeam: item.subjectTeam,
  });
  if (!fixture) {
    return {
      kind: "READ_FAILED",
      reason: item.matchup
        ? `Odds Terminal is not listing a ${plan.league.toUpperCase()} game matching "${item.matchup}" right now.`
        : "This pick records no matchup, and Odds Terminal needs one to identify the game.",
    };
  }
  const id = typeof fixture.id === "string" ? fixture.id : null;
  if (!id) return { kind: "READ_FAILED", reason: "That Odds Terminal fixture carries no id." };
  return { fixture, streamPath: oddsTerminalStreamPath(plan, id) };
}

/**
 * The outcome for one pick, from the stream entries the relay collected.
 *
 * Returns the same `ClosingReadOutcome` every other source produces, so everything downstream --
 * `buildClosingVerdict`, the modal's rendering -- cannot tell which source produced it.
 */
export function readRelayedStream(
  item: ClosingWorkItem,
  plan: OddsTerminalReadPlan,
  relayed: RelayedStream
): ClosingReadOutcome {
  const source = sourceFor(
    plan,
    typeof relayed.fixture.id === "string" ? relayed.fixture.id : null
  );
  const parsed = normalizeOddsTerminalStream(relayed.entries, plan, relayed.fixture, {
    atLine: item.takenLine,
  });

  if (!parsed.ok) {
    // The parser's reason names the markets the stream DID carry, which is nearly always the
    // actionable detail -- a market spelled differently rather than one that is missing.
    return { kind: "READ_FAILED", reason: parsed.reason ?? "unreadable stream" };
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
