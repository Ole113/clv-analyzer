import {
  findMatchingRow,
  normalizeScreenMarket,
  planScreenRead,
  type ClosingReadOutcome,
  type ClosingSourceInfo,
  type ClosingWorkItem,
  type ParsedRow,
  type ScreenReadPlan,
} from "@clv/shared";

/**
 * Read closing lines from PropProfessor's odds screen -- permanently disabled.
 *
 * This used to POST directly to `backend.propprofessor.com` on a 60-second alarm. That automation
 * is what got the PropProfessor account banned (2026-09), so `fetchScreen` below throws before it
 * ever builds a request, let alone sends one, regardless of what token is cached.
 *
 * The rest of this module -- the planning, batching and matching -- stays, rather than being
 * deleted, so the shape of what happened here is not lost, and so a future decision to read
 * PropProfessor again (if ever made, deliberately, by a human) has one obvious place to undo this.
 * Nothing calls `readClosingLines` automatically any more: `service-worker.ts` no longer creates
 * the closing alarm, so this is unreachable in normal operation.
 */

/** One request answers every pick sharing a league and market. */
function groupKey(plan: ScreenReadPlan): string {
  return `${plan.body.league}::${plan.body.market}`;
}

async function fetchScreen(_plan: ScreenReadPlan): Promise<unknown> {
  throw new Error(
    "PropProfessor reads are disabled: this account was banned for automated access and the " +
      "extension must never contact backend.propprofessor.com again."
  );
}

function sourceFor(plan: ScreenReadPlan): ClosingSourceInfo {
  return {
    site: "PROPPROFESSOR_SCREEN",
    url: plan.url,
    league: plan.body.league,
    market: plan.body.market,
  };
}

function targetFor(item: ClosingWorkItem) {
  return {
    marketType: item.marketType,
    player: item.player,
    subjectTeam: item.subjectTeam,
    matchup: item.matchup,
    statMarket: item.statMarket,
    side: item.side,
    externalPropId: item.externalPropId,
  };
}

/** Names of the rows we did see, so an absent selection says what *was* there. */
function sampleNamesFrom(rows: ParsedRow[], limit = 6): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.player ?? row.subjectTeam;
    if (name) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

/**
 * Reads the close for a batch of due picks.
 *
 * Batching is by (league, market) rather than by game: one read of "NCAAF / Player Rushing Yards"
 * prices every rushing-yards pick on the slate at once, which keeps request volume to roughly one
 * per market regardless of how many picks are riding on it.
 */
export async function readClosingLines(
  items: ClosingWorkItem[]
): Promise<Map<string, ClosingReadOutcome>> {
  const outcomes = new Map<string, ClosingReadOutcome>();
  const batches = new Map<string, { plan: ScreenReadPlan; items: ClosingWorkItem[] }>();

  for (const item of items) {
    const plan = planScreenRead(item);
    if ("kind" in plan) {
      outcomes.set(
        item.id,
        plan.kind === "noEquivalent"
          ? { kind: "NO_CLOSING_MARKET", reason: plan.reason }
          : // An unmapped market is a gap in our own alias table, and it has to stay loud: quietly
            // recording it as unavailable would recreate the exact bug this redesign fixes.
            { kind: "READ_FAILED", reason: `${plan.reason}. Add it to MARKET_ALIASES.` }
      );
      continue;
    }
    const key = groupKey(plan);
    const batch = batches.get(key);
    if (batch) batch.items.push(item);
    else batches.set(key, { plan, items: [item] });
  }

  for (const { plan, items: batched } of batches.values()) {
    const source = sourceFor(plan);
    let parsed;
    try {
      parsed = normalizeScreenMarket(await fetchScreen(plan), plan);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "screen read failed";
      for (const item of batched) outcomes.set(item.id, { kind: "READ_FAILED", reason });
      continue;
    }

    if (!parsed.ok) {
      for (const item of batched) {
        outcomes.set(item.id, { kind: "READ_FAILED", reason: parsed.reason ?? "unreadable response" });
      }
      continue;
    }

    if (parsed.rows.length === 0) {
      for (const item of batched) {
        outcomes.set(item.id, { kind: "MARKET_NOT_OFFERED", source, availableMarkets: [] });
      }
      continue;
    }

    for (const item of batched) {
      const row = findMatchingRow(parsed.rows, targetFor(item));
      outcomes.set(
        item.id,
        row
          ? { kind: "MATCHED", row, source }
          : {
              kind: "SELECTION_ABSENT",
              source,
              candidateCount: parsed.rows.length,
              sampleNames: sampleNamesFrom(parsed.rows),
            }
      );
    }
  }

  return outcomes;
}
