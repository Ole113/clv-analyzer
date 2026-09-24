import {
  filterOddsTerminalOdds,
  findOddsTerminalFixture,
  oddsTerminalBookCoverage,
  oddsTerminalFixturesOf,
  oddsTerminalFixturesPath,
  oddsTerminalNextPage,
  oddsTerminalOddsOf,
  oddsTerminalOddsPath,
  oddsTerminalUrl,
  type OddsTerminalFixture,
  type OddsTerminalOddsEntry,
  type OddsTerminalReadPlan,
} from "@clv/shared";

/**
 * Reads one market from Odds Terminal, on the session the user's own browser is already signed in
 * with.
 *
 * ## This is the only file in the project that contacts Odds Terminal
 *
 * Say that plainly, because it is the property everything else depends on. The planners in
 * `shared/src/sources/` produce relative paths and cannot express a host; the server is handed
 * entries and does arithmetic on them. The origin is added here, by `oddsTerminalUrl`, and
 * nowhere else -- `oddsjam-automation-guard.test.ts` asserts it.
 *
 * ## Why a background fetch, and not the tab this used to open
 *
 * The previous design opened a tab on oddsterminal.org from inside the click and had a content
 * script in that tab do the fetching. Two things were wrong with it. The small one: a tab the user
 * did not ask for appeared on every click, which is not what "show me the odds" should do. The
 * large one: it did not work, and could not -- it read player props from the SSE endpoint, which
 * answers a fixture subscription with 200 and then sends nothing, so every lookup ended in the
 * 30-second timeout.
 *
 * A background fetch is both simpler and quieter. Chrome treats a request from an extension as
 * same-site when the extension holds a host permission for it (see "Storage and cookies" in the
 * extension docs), so `credentials: "include"` sends the session cookie the user already has. This
 * code never sees that cookie, never stores it and never transmits it anywhere -- which is the
 * distinction from the PropProfessor token bridge that got that account banned (2026-09). That one
 * captured a bearer token out of the page and handed it to a server that then read on a timer.
 *
 * ## The rule this file lives under
 *
 * Every read is the direct consequence of a click. There is no alarm, no interval, no retry loop
 * and no queue in this module, and the guard test fails if one appears. If nobody clicks, nothing
 * here ever runs.
 */

/** How long any one request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How few books quoting the market is too few to stop at.
 *
 * The user's book ranking is not a ranking of prop coverage. On one NFL game (2026-09-24)
 * DraftKings quoted 20 player markets and FanDuel 13, while Pinnacle, BetOnline and Circa -- all
 * ranked above them in this install -- quoted none at all. So a chunk of five that comes back with
 * almost nothing is followed by the next five rather than reported as "no market", and the entries
 * are merged.
 *
 * Three is the bar, not two. This install's own top five are circa, fanduel, pinnacle, betonline
 * and novig: on a player prop that is fanduel and novig answering and three books with nothing to
 * say, which clears a bar of two and stops -- leaving DraftKings, the single best prop book on this
 * feed, in the next chunk and unread. An average of two books is a thin thing to put a decision on.
 * The cost of the bar being three is one more request on prop lookups; game markets, where all five
 * answer, still stop at the first chunk.
 */
const MIN_BOOKS = 3;

export class OddsTerminalSignedOutError extends Error {
  constructor() {
    super(
      "Odds Terminal did not recognise your session. Open oddsterminal.org, sign in, and try " +
        "again -- and if you are already signed in there, allow third-party cookies for that site."
    );
    this.name = "OddsTerminalSignedOutError";
  }
}

/** What a finished read hands to the server: the fixture it was about, and the entries for it. */
export interface OddsTerminalRead {
  fixture: OddsTerminalFixture;
  entries: OddsTerminalOddsEntry[];
  /** Market names the fixture did carry, so "not quoting that" can say what it saw instead. */
  marketsSeen: string[];
}

/** One GET, with the shared timeout and the user's own session. */
async function getJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(oddsTerminalUrl(path), {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) throw new OddsTerminalSignedOutError();
    if (response.status === 429) {
      throw new Error("Odds Terminal is rate-limiting this account. Give it a minute, then hit Refresh.");
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(
        detail
          ? `Odds Terminal answered ${response.status}: ${detail}`
          : `Odds Terminal answered ${response.status}.`
      );
    }

    // A signed-out session can also arrive as the sign-in page with a 200 on it, which is how a
    // Cloudflare-fronted app usually says no. Anything that is not JSON is treated as that.
    const type = response.headers.get("content-type") ?? "";
    if (!/\bjson\b/i.test(type)) throw new OddsTerminalSignedOutError();

    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Odds Terminal did not answer in time. Hit Refresh to try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which fixture the pick is about.
 *
 * The slate comes in pages of 100, and a seven-day college football slate is 121 games -- so the
 * first page is not the slate, and a reader that stops there cannot find a fifth of NCAAF picks.
 * Pages are collected first and matched once, all together, rather than page by page: the matcher
 * **refuses on ambiguity**, and that guarantee is only worth anything if it can see every candidate
 * at once. Matching per page would quietly return the first of two identical-looking games because
 * the second happened to be on the next page.
 *
 * In the normal case this is still a single request: when the board recorded a kickoff the window
 * is half a day wide and one page covers it.
 */
async function findFixture(
  plan: OddsTerminalReadPlan,
  target: { matchup: string | null; subjectTeam: string | null }
): Promise<OddsTerminalFixture | null> {
  const slate: OddsTerminalFixture[] = [];
  let page: number | null = 1;

  while (page !== null) {
    const body = await getJson(oddsTerminalFixturesPath(plan, { page }));
    slate.push(...oddsTerminalFixturesOf(body));
    page = oddsTerminalNextPage(body, page);
  }

  return findOddsTerminalFixture(slate, plan, target);
}

/**
 * The whole read: find the game, then ask for its odds until the market is covered.
 *
 * Throws with a sentence a person can act on. Returns `null` only for "the game is not on this
 * slate", which the caller words for itself since it knows what was asked for.
 */
export async function readOddsTerminal(
  plan: OddsTerminalReadPlan,
  target: { matchup: string | null; subjectTeam: string | null }
): Promise<OddsTerminalRead | null> {
  const fixture = await findFixture(plan, target);
  if (!fixture) return null;

  const fixtureId = typeof fixture.id === "string" ? fixture.id : null;
  if (!fixtureId) return null;

  const entries: OddsTerminalOddsEntry[] = [];
  const marketsSeen = new Set<string>();

  for (const books of plan.bookChunks) {
    const body = await getJson(oddsTerminalOddsPath(plan, fixtureId, books));
    const filtered = filterOddsTerminalOdds(oddsTerminalOddsOf(body), plan, fixtureId);
    entries.push(...filtered.entries);
    for (const market of filtered.marketsSeen) marketsSeen.add(market);

    // Enough books have answered. Stopping here is the normal path -- the second chunk exists for
    // the install whose top five books do not price props, not as a routine second request.
    if (oddsTerminalBookCoverage(entries) >= MIN_BOOKS) break;
  }

  return { fixture, entries, marketsSeen: [...marketsSeen] };
}
