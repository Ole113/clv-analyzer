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
import { getScreenToken } from "./pp-token";

/**
 * Reads closing lines from PropProfessor's odds screen.
 *
 * Replaces the old board reader, which re-opened the Fantasy Optimizer in a background tab and
 * scrolled it looking for the pick. That could only ever find props which still had edge, so a
 * pick that had genuinely moved -- the ones worth measuring -- came back "not found".
 *
 * Two things fall away with the screen being a plain JSON endpoint, and they are why this file is
 * so much shorter than what it replaces:
 *
 *  - **No page scraping**, and therefore none of the `executeScript` serialization constraints the
 *    DOM parsers live under. The response is parsed by an ordinary importable module.
 *  - **No scrolling.** Every selection for a market arrives in one response, so there is no
 *    virtualized grid to page through, and no reading a board one screenful at a time.
 *
 * What does *not* fall away is authentication. The endpoint requires `Authorization: Bearer <JWT>`,
 * and the token lives only in the app's own memory, so it is observed in page context and cached --
 * see `pp-token.ts`. A tab is opened only when no usable token is cached, roughly once per token
 * lifetime, never once per pick.
 *
 * OddsJam is not reachable from here and must stay that way. That subscription is paid a year up
 * front, so a ban is unrecoverable, whereas the PropProfessor account is replaceable. Picks
 * *captured* on OddsJam are read here like any other -- the capture site is provenance, not a
 * read target -- and a test asserts no module in this directory names oddsjam.com.
 */

/** One request answers every pick sharing a league and market. */
function groupKey(plan: ScreenReadPlan): string {
  return `${plan.body.league}::${plan.body.market}`;
}

async function postScreen(plan: ScreenReadPlan, token: string): Promise<Response> {
  return fetch(plan.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(plan.body),
  });
}

/**
 * One screen request, refreshing the bearer token once if it has expired.
 *
 * A 401 is the only staleness signal there is: the token is a JWT this extension deliberately does
 * not parse, so expiry is discovered rather than predicted. One retry, never a loop -- a second
 * 401 with a freshly captured token means something other than expiry is wrong (signed out, or the
 * subscription lapsed), and hammering it would not help.
 */
async function fetchScreen(plan: ScreenReadPlan): Promise<unknown> {
  let token = await getScreenToken();
  if (!token) {
    throw new Error(
      "No PropProfessor session token available. Open propprofessor.com/screen in this browser " +
        "and make sure you are signed in."
    );
  }

  let response = await postScreen(plan, token);
  if (response.status === 401) {
    token = await getScreenToken(true);
    if (!token) throw new Error("PropProfessor session token expired and could not be renewed");
    response = await postScreen(plan, token);
  }

  if (!response.ok) throw new Error(`screen responded ${response.status}`);
  return response.json();
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
