/**
 * Deep-linking into OddsJam's own site -- the full odds comparison, not the Fantasy board this
 * extension already captures from.
 *
 * ## What the button has to do, and the one thing it still must not
 *
 * A market's exact URL is `/game/<opaque-slug>?market=<id>`, and neither half can be constructed
 * from a row: the slug is an id OddsJam assigns per fixture, and the market id is OddsJam's own
 * dropdown value. Both have to be *read* from OddsJam. This used to mean the button only worked for
 * games the user had already browsed to -- a cache filled passively, and a click on anything else
 * degraded to the sport's odds list.
 *
 * That restriction is lifted. OddsJam support was asked, in writing, whether a Chrome extension may
 * use scripting to open OddsJam odds pages -- naming this exact URL shape -- and answered "this will
 * not be an issue" (2026-09-21). So a click that cannot be answered from the cache now opens the
 * page that holds the missing piece and lets the tab finish the job itself: the sport's listing
 * resolves the slug (pressing "Load more games" as far as `ODDSJAM_MAX_LOAD_MORE` when the slate is
 * paginated), and the game page's own `__NEXT_DATA__` resolves the market id.
 *
 * What is permitted is scripted navigation *of the tab the user's own click opened*. What is still
 * forbidden, and is what `oddsjam-automation-guard.test.ts` exists to keep forbidden, is anything
 * that reaches OddsJam without a user asking: a background fetch, a tab opened on a timer, polling.
 * The old approach to this feature fetched OddsJam's odds listing from the background worker, which
 * is squarely on the wrong side of that line no matter what the permission says -- the subscription
 * is paid a year up front and a ban is unrecoverable.
 *
 * ## The two halves
 *
 * This module is the pure, storage-agnostic half: matching a row against what has been captured
 * (`resolveOddsJamLink`), deciding what the opened tab still owes (`planOddsJamLink`), and deciding
 * each step that tab should take once it is there (`planOddsJamListingStep`, `planOddsJamGameStep`).
 * The DOM half lives in `extension/src/content/oddsjam-site/` -- `capture.ts` reading what a page
 * already put in front of it, `resolve.ts` carrying out the steps planned here.
 *
 * The cache is still what makes the common case instant, and it is still filled passively: every
 * page either half visits records its game and, from a game page, that sport's entire market
 * vocabulary. One resolve for a sport is all it takes before every later click for that sport lands
 * on the exact URL directly.
 *
 * A market that genuinely is not in OddsJam's vocabulary still resolves to the bare game page rather
 * than a guessed `?market=`, and a fixture that is not on the slate at all still leaves the user on
 * the listing. Both degrade to the honest answer rather than a wrong one -- the same discipline
 * `resolveClosingMarket` was hardened to keep for PropProfessor, after "Total Turnovers" was once
 * silently answered as "Total Points" by a table that filled in a default instead of admitting a
 * gap.
 */

import { teamsOverlap } from "./matching";
import { marketFilterKey } from "./markets";
import { resolveClosingMarket } from "./markets";
import type { MarketType } from "./types";

/** A game this extension has actually seen a page for. */
export interface OddsJamGameEntry {
  /** OddsJam's own URL segment for the sport ("nfl"), not whatever spelling a board captured. */
  sportSlug: string;
  /** The `/game/<slug>` path segment, opaque and OddsJam's own. */
  slug: string;
  /** OddsJam's own spelling of each side, as observed -- not normalized, so later matching can
   *  apply the same tolerance a board's own team spelling already gets. */
  awayTeam: string;
  homeTeam: string;
  /** Null when the page this was captured from did not carry a readable kickoff time. */
  kickoffIso: string | null;
  /** When this extension observed it, for pruning and for breaking ties between entries with no
   *  kickoff to compare against. */
  capturedAt: number;
}

/** One market OddsJam prices, as its own dropdown names it. */
export interface OddsJamMarketEntry {
  /** The exact `?market=` value. */
  id: string;
  label: string;
}

/**
 * Sport strings the boards emit -> OddsJam's URL path segment.
 *
 * Moved here from the server's `oddsScreenUrlFor` (see `server/src/lib/queries.ts`), which built
 * the same table for the same reason and now imports this one instead of keeping its own copy.
 * Verified live for NFL only -- `oddsjam.com/nfl/odds` and a captured game's `__NEXT_DATA__` both
 * confirmed on 2026-09-21 -- the rest is carried over from that earlier table rather than
 * independently re-verified. A wrong entry here fails safe: `oddsJamSportSlug` returning a slug
 * OddsJam does not actually serve just means the sport-level fallback link 404s, which is visibly
 * wrong and easy to report, not a silently mismatched market the way a bad game-slug guess would be.
 */
export const ODDSJAM_SPORT_SLUGS: Record<string, string> = {
  nfl: "nfl",
  ncaaf: "ncaaf",
  "college football": "ncaaf",
  cfb: "ncaaf",
  nba: "nba",
  wnba: "wnba",
  mlb: "mlb",
  nhl: "nhl",
  ncaab: "ncaab",
  "college basketball": "ncaab",
  cbb: "ncaab",
  // OddsJam has no ATP/WTA split; both tours are one "tennis" path, the same collapse
  // PROPPROFESSOR_LEAGUES makes for the same reason.
  atp: "tennis",
  wta: "tennis",
  tennis: "tennis",
};

export function oddsJamSportSlug(sport: string | null): string | null {
  if (!sport) return null;
  return ODDSJAM_SPORT_SLUGS[sport.trim().toLowerCase()] ?? null;
}

/**
 * PropProfessor spells a period-qualified market `"<base> - <period>"` -- `extractPeriod`'s own
 * convention, reattached by `resolveClosingMarket`'s `withPeriod`. OddsJam's own dropdown spells the
 * same idea period-first with no dash: "1st Quarter Player Passing Yards", "1st Half Total Points",
 * both confirmed live off the real dropdown. This only ever reorders an already-resolved string; it
 * never invents a period that was not already there, and a market with none passes through
 * unchanged.
 */
export function oddsJamCandidateLabel(canonicalMarket: string): string {
  const dash = canonicalMarket.indexOf(" - ");
  if (dash === -1) return canonicalMarket;
  const base = canonicalMarket.slice(0, dash);
  const period = canonicalMarket.slice(dash + 3);
  return `${period} ${base}`;
}

/**
 * The real OddsJam market id for a candidate label, read only from a vocabulary this extension
 * actually captured -- never fabricated from the label text itself, however regular the pattern
 * looks ("Player Rushing Attempts" -> "player_rushing_attempts" holds most of the time and is
 * confirmed wrong often enough in the parenthesised and period-qualified cases that guessing it is
 * not worth the risk a wrong guess carries).
 *
 * Matched case/whitespace-normalized and agnostic to a leading "Player " on either side, via the
 * same `marketFilterKey` PropProfessor's own alias table is matched through -- OddsJam's captured
 * labels already come back consistently "Player "-prefixed in every case checked, but there is no
 * reason to assume that holds for every sport when the tolerance costs nothing.
 */
export function findMarketId(
  vocabulary: OddsJamMarketEntry[],
  candidateLabel: string
): string | null {
  const want = marketFilterKey(candidateLabel);
  if (!want) return null;
  return vocabulary.find((m) => marketFilterKey(m.label) === want)?.id ?? null;
}

/**
 * How long a captured game entry is trusted for once its kickoff has passed.
 *
 * Long enough that clicking the button during or just after a game (checking a live or closing
 * number) still resolves; short enough that this week's Cowboys/Eagles cannot get answered with a
 * slug captured for a divisional rematch from a month ago. Entries with no kickoff at all -- a
 * listing-page capture that could not read a time -- age out on the same clock from `capturedAt`
 * instead.
 */
export const GAME_ENTRY_TTL_MS = 24 * 60 * 60_000;

export function pruneGameEntries(entries: OddsJamGameEntry[], now: number): OddsJamGameEntry[] {
  return entries.filter((e) => {
    const anchor = e.kickoffIso ? Date.parse(e.kickoffIso) : e.capturedAt;
    return Number.isFinite(anchor) && now - anchor < GAME_ENTRY_TTL_MS;
  });
}

/** Whether an entry and a (team, opponent) pair name the same two sides, in either order. Requires
 *  both sides of the pair to be real -- see `teamsOverlap`'s own comment on why a missing side must
 *  not vacuously match every captured game. */
function sameFixture(entry: OddsJamGameEntry, team: string | null, opponent: string | null): boolean {
  if (!team || !opponent) return false;
  return (
    (teamsOverlap(entry.awayTeam, team) && teamsOverlap(entry.homeTeam, opponent)) ||
    (teamsOverlap(entry.awayTeam, opponent) && teamsOverlap(entry.homeTeam, team))
  );
}

/**
 * The captured game a row is about, or null when nothing captured matches.
 *
 * More than one candidate means the same two teams play each other more than once in view -- a
 * divisional rematch, a doubleheader -- and the row's own kickoff is what actually tells them apart.
 * Without one to compare against (a market-lookup row with no game time of its own), the most
 * recently observed candidate is the better guess than an arbitrary one.
 */
export function findGameEntry(
  entries: OddsJamGameEntry[],
  target: {
    sportSlug: string;
    team: string | null;
    opponent: string | null;
    gameStartTimeIso: string | null;
  }
): OddsJamGameEntry | null {
  const candidates = entries.filter(
    (e) => e.sportSlug === target.sportSlug && sameFixture(e, target.team, target.opponent)
  );
  if (candidates.length <= 1) return candidates[0] ?? null;

  const wantTime = target.gameStartTimeIso ? Date.parse(target.gameStartTimeIso) : NaN;
  if (Number.isFinite(wantTime)) {
    let best = candidates[0];
    let bestDelta = Math.abs((best.kickoffIso ? Date.parse(best.kickoffIso) : Infinity) - wantTime);
    for (const c of candidates.slice(1)) {
      const delta = Math.abs((c.kickoffIso ? Date.parse(c.kickoffIso) : Infinity) - wantTime);
      if (delta < bestDelta) {
        best = c;
        bestDelta = delta;
      }
    }
    return best;
  }

  return [...candidates].sort((a, b) => b.capturedAt - a.capturedAt)[0];
}

/** Enough of a row to look it up -- deliberately a plain object rather than `ParsedRow` itself, so
 *  this module has no dependency on how a row was parsed, only on what it says. */
export interface OddsJamLinkTarget {
  sport: string | null;
  statMarket: string | null;
  marketType: MarketType;
  team: string | null;
  opponent: string | null;
  gameStartTimeIso: string | null;
}

/**
 * The market id for a target, resolved via `resolveClosingMarket` and then confirmed against a
 * captured vocabulary -- reusing PropProfessor's whole alias table, period handling and
 * game-/team-total defaulting rather than maintaining a second one, on the strength of both sites
 * pricing from the same underlying data ("Player Rushing Attempts", "Total Points", "Point Spread"
 * and "Moneyline" all confirmed identical between the two).
 *
 * `resolveClosingMarket` also gates on whether *PropProfessor* recognises the sport's league, which
 * is a dependency this function does not otherwise have. A sport OddsJam prices but that table does
 * not know yet fails here even though the game itself may already be found -- an acceptable
 * degradation, since it costs only the market filter, not the link, and is exactly as fixable as any
 * other gap in that table (see its own module comment).
 */
export function oddsJamMarketId(
  sport: string | null,
  statMarket: string,
  marketType: MarketType,
  vocabulary: OddsJamMarketEntry[]
): string | null {
  const resolved = resolveClosingMarket(sport, statMarket, marketType);
  if (!resolved.ok) return null;
  return findMarketId(vocabulary, oddsJamCandidateLabel(resolved.market));
}


/**
 * How much of a link a click was able to answer from the cache alone.
 *
 * The distinction is the whole point of the on-page resolver below: "exact" is finished and needs
 * no further work, while "game" and "sport" name precisely which half is still missing and so what
 * the opened tab should go and read for itself.
 */
export type OddsJamLinkPrecision = "exact" | "game" | "sport";

export interface OddsJamLink {
  url: string;
  precision: OddsJamLinkPrecision;
}

/** `/game/<slug>`, with the market filter when one is known. */
export function oddsJamGameUrl(slug: string, marketId: string | null): string {
  const base = `https://oddsjam.com/game/${slug}`;
  return marketId ? `${base}?market=${encodeURIComponent(marketId)}` : base;
}

export function oddsJamSportUrl(sportSlug: string): string {
  return `https://oddsjam.com/${sportSlug}/odds`;
}

/**
 * What the cache alone can answer for one row, in order of how much is known:
 *
 *  1. Game and market both cached -> the exact `/game/<slug>?market=<id>` a person clicking through
 *     by hand would land on.
 *  2. Game cached, market not -> the bare game page, whose own `__NEXT_DATA__` carries the market
 *     vocabulary needed to finish the job.
 *  3. Neither -> the sport's own odds list, which is where the game's slug can be found.
 *
 * Only case 1 is a finished answer. `planOddsJamLink` is what turns 2 and 3 into one, by handing
 * the opened tab the request that says what it still has to resolve.
 */
export function resolveOddsJamLink(
  target: OddsJamLinkTarget,
  games: OddsJamGameEntry[],
  marketsBySport: Record<string, OddsJamMarketEntry[]>
): OddsJamLink | null {
  const sportSlug = oddsJamSportSlug(target.sport);
  if (!sportSlug) return null;

  const game = findGameEntry(games, {
    sportSlug,
    team: target.team,
    opponent: target.opponent,
    gameStartTimeIso: target.gameStartTimeIso,
  });
  if (!game) return { url: oddsJamSportUrl(sportSlug), precision: "sport" };

  const marketId = target.statMarket
    ? oddsJamMarketId(target.sport, target.statMarket, target.marketType, marketsBySport[sportSlug] ?? [])
    : null;

  return { url: oddsJamGameUrl(game.slug, marketId), precision: marketId ? "exact" : "game" };
}

/* ------------------------------------------------------------------------------------------------
 * Finishing the job in the opened tab
 * ---------------------------------------------------------------------------------------------- */

/**
 * The fragment key carrying an unfinished request into the tab the click opened.
 *
 * A fragment rather than a query string or a `chrome.storage` handoff for three reasons: it is never
 * sent to OddsJam's server (so this adds nothing to the request the navigation was already going to
 * make), it survives being the thing `window.open` was handed inside the user's own gesture with no
 * async step in between, and it needs no tab-id bookkeeping -- the request travels with the tab
 * because it *is* part of the tab's URL.
 */
export const ODDSJAM_REQUEST_KEY = "clv-oj";

/** `encodeURIComponent` of the JSON, not base64: it survives a copied-and-pasted URL, stays legible
 *  to anyone who looks at the address bar and wonders what the extension is doing, and needs no
 *  polyfill in a content script. */
export function encodeOddsJamRequest(target: OddsJamLinkTarget): string {
  return `#${ODDSJAM_REQUEST_KEY}=${encodeURIComponent(JSON.stringify(target))}`;
}

/** The request a page was opened with, or null when there is none or it does not parse. Everything
 *  the resolver does is gated on this being non-null, which is what keeps an ordinary visit to
 *  oddsjam.com entirely passive. */
export function decodeOddsJamRequest(hash: string): OddsJamLinkTarget | null {
  const prefix = `#${ODDSJAM_REQUEST_KEY}=`;
  if (!hash.startsWith(prefix)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(hash.slice(prefix.length)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = parsed as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  // `marketType` is the one field with a closed vocabulary, and it only ever reaches
  // `resolveClosingMarket`, which already rejects what it does not know -- so it is carried through
  // as-is rather than validated against a list this module would then have to keep in step.
  if (typeof t.marketType !== "string") return null;
  return {
    sport: text(t.sport),
    statMarket: text(t.statMarket),
    marketType: t.marketType as MarketType,
    team: text(t.team),
    opponent: text(t.opponent),
    gameStartTimeIso: text(t.gameStartTimeIso),
  };
}

/**
 * The URL the button opens, complete with whatever the opened tab still has to work out for itself.
 *
 * An exact hit goes straight there with no fragment at all -- nothing left to do, and no reason to
 * leave the extension's marker in the user's address bar. Anything less carries the request, so the
 * page it lands on can finish the resolution the cache could not.
 */
export function planOddsJamLink(
  target: OddsJamLinkTarget,
  games: OddsJamGameEntry[],
  marketsBySport: Record<string, OddsJamMarketEntry[]>
): string | null {
  const link = resolveOddsJamLink(target, games, marketsBySport);
  if (!link) return null;
  return link.precision === "exact" ? link.url : link.url + encodeOddsJamRequest(target);
}

/** One step the resolver should take on the page it is currently sitting on. */
export type OddsJamResolveStep =
  | { kind: "navigate"; url: string }
  /** Press the listing's "Load more games" button and look again -- the slate is paginated and the
   *  game wanted is past the fold. */
  | { kind: "load-more" }
  /** Nothing left to do, whether because the job is finished or because this page cannot finish it.
   *  Either way the resolver stops and clears the request. */
  | { kind: "done" };

/**
 * How many times the listing's "Load more games" button may be pressed before giving up.
 *
 * Each press appends one more page of the slate. Twelve is far past any real slate -- a busy college
 * football Saturday runs to a few pages -- and exists only so a listing that keeps offering the
 * button forever cannot turn one click into an unbounded loop of presses.
 */
export const ODDSJAM_MAX_LOAD_MORE = 12;

/** A game link as the listing page renders it, before anything is known about kickoff. */
export interface OddsJamListingLink {
  slug: string;
  awayTeam: string;
  homeTeam: string;
}

/**
 * What to do on `oddsjam.com/<sport>/odds` while resolving a request.
 *
 * The slate renders progressively and is paginated, so "not found" is genuinely ambiguous between
 * "not on this slate" and "not loaded yet" -- which is why a miss asks for one more page rather
 * than concluding anything, and only stops once the button is gone or the cap is hit. Stopping
 * leaves the user on the listing, which is a page they can use, rather than on a guessed URL.
 */
export function planOddsJamListingStep(
  request: OddsJamLinkTarget,
  sportSlug: string,
  links: OddsJamListingLink[],
  state: { hasLoadMore: boolean; loadMoreCount: number }
): OddsJamResolveStep {
  const now = Date.now();
  const match = findGameEntry(
    links.map((l) => ({ ...l, sportSlug, kickoffIso: null, capturedAt: now })),
    {
      sportSlug,
      team: request.team,
      opponent: request.opponent,
      gameStartTimeIso: request.gameStartTimeIso,
    }
  );
  if (match) {
    // Carries the request forward: the game page is where the market vocabulary lives, so the
    // second half of the resolution happens there.
    return { kind: "navigate", url: oddsJamGameUrl(match.slug, null) + encodeOddsJamRequest(request) };
  }
  if (state.hasLoadMore && state.loadMoreCount < ODDSJAM_MAX_LOAD_MORE) return { kind: "load-more" };
  return { kind: "done" };
}

/**
 * What to do on `oddsjam.com/game/<slug>` while resolving a request.
 *
 * This is only ever reached with the market still unresolved, and the page's own `__NEXT_DATA__`
 * has just supplied the sport's whole vocabulary -- so either the market is in it, and the filter
 * goes on the URL, or it genuinely is not, and the bare game page is the honest answer. A URL that
 * already carries a `?market=` is finished by definition and never re-navigated, which is also what
 * stops the navigation below from looping back into itself.
 *
 * The extra load this costs happens once per sport: the vocabulary it reads on the way through is
 * cached, so the next click for that sport resolves the market before the tab is even opened.
 */
export function planOddsJamGameStep(
  request: OddsJamLinkTarget,
  slug: string,
  currentMarketParam: string | null,
  vocabulary: OddsJamMarketEntry[]
): OddsJamResolveStep {
  if (currentMarketParam) return { kind: "done" };
  const marketId = request.statMarket
    ? oddsJamMarketId(request.sport, request.statMarket, request.marketType, vocabulary)
    : null;
  if (!marketId) return { kind: "done" };
  return { kind: "navigate", url: oddsJamGameUrl(slug, marketId) };
}
