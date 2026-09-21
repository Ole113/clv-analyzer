/**
 * Deep-linking into OddsJam's own site -- the full odds comparison, not the Fantasy board this
 * extension already captures from -- without ever contacting OddsJam automatically.
 *
 * ## Why this can only ever be a passive cache
 *
 * OddsJam's account is paid a year up front and a ban is unrecoverable, unlike PropProfessor's
 * (replaceable), which is why `oddsjam-automation-guard.test.ts` forbids any code that runs on a
 * timer from naming `oddsjam.com` at all. A market's exact URL is `/game/<opaque-slug>?market=<id>`,
 * and there is no way to construct `<opaque-slug>` from a team's name -- it is an id OddsJam assigns
 * per fixture. The old approach to this (see the project's own history) fetched OddsJam's odds
 * listing from the background worker to find it, which is exactly the traffic that rule exists to
 * stop.
 *
 * What this module works from instead is pages the user opens themselves. `oddsjam.com/game/<slug>`
 * embeds the fixture's identity and, as a bonus, that sport's entire market vocabulary (`id` and
 * `label` for every market OddsJam prices) in a `__NEXT_DATA__` blob the browser already downloaded
 * as part of loading the page -- nothing here re-requests it. `oddsjam.com/<sport>/odds` lists a
 * whole slate of upcoming games as plain links once the page has rendered. A content script matched
 * on those two page shapes (`extension/src/content/oddsjam-site/capture.ts`) reads what is already
 * there and records it; this module is the pure, storage-agnostic half of that -- matching a row
 * against what has been captured, and building the URL once it has enough to.
 *
 * A team pair this has never seen resolves to nothing better than the sport's own odds list, and a
 * market this has never seen resolves to the bare game page rather than a guessed `?market=`. Both
 * degrade to the honest answer rather than a wrong one -- the same discipline
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
function oddsJamMarketId(
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
 * The URL the "OddsJam odds" button opens for one row, or null when the sport itself is not one
 * OddsJam's site is known to cover.
 *
 * Three honest answers, in order of how much is known:
 *
 *  1. Game and market both resolved -> the exact `/game/<slug>?market=<id>` a person clicking
 *     through by hand would land on.
 *  2. Game resolved, market not -> the bare game page. Still the right game; the market filter is
 *     just something this extension has not captured a name for yet.
 *  3. Game not resolved -> the sport's own odds list, so browsing it (which is itself how a game
 *     gets captured) is one click away rather than a manual URL.
 */
export function resolveOddsJamUrl(
  target: OddsJamLinkTarget,
  games: OddsJamGameEntry[],
  marketsBySport: Record<string, OddsJamMarketEntry[]>
): string | null {
  const sportSlug = oddsJamSportSlug(target.sport);
  if (!sportSlug) return null;

  const game = findGameEntry(games, {
    sportSlug,
    team: target.team,
    opponent: target.opponent,
    gameStartTimeIso: target.gameStartTimeIso,
  });
  if (!game) return `https://oddsjam.com/${sportSlug}/odds`;

  const marketId = target.statMarket
    ? oddsJamMarketId(target.sport, target.statMarket, target.marketType, marketsBySport[sportSlug] ?? [])
    : null;

  return marketId
    ? `https://oddsjam.com/game/${game.slug}?market=${encodeURIComponent(marketId)}`
    : `https://oddsjam.com/game/${game.slug}`;
}
