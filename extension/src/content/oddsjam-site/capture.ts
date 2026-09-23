import { oddsJamSportSlug, type OddsJamMarketEntry } from "@clv/shared";
import { recordGame, recordMarkets } from "./store";

/**
 * Passively fills the OddsJam deep-link cache from every oddsjam.com page this extension is on.
 *
 * This is what makes the common case instant: a game or a market already captured needs no resolve
 * at all, and the button opens the exact URL straight from the board. Everything here reads data
 * the browser already downloaded as part of loading the page; nothing here issues a request, opens
 * a tab, or navigates -- taking the tab somewhere is `resolve.ts`'s job alone, and the guard test
 * keeps that split honest by forbidding navigation in this file specifically.
 *
 * Two page shapes, read differently:
 *
 *  - `oddsjam.com/<sport>/odds` lists a slate of upcoming games as plain links once the page has
 *    rendered -- each anchor's two `<p>` children are the away and home team, confirmed against the
 *    live DOM on 2026-09-21. No kickoff time is scraped from here: the listed time is relative
 *    prose ("Today", "Thursday") that is not worth the fragility of parsing when the game page
 *    itself hands back a clean ISO string.
 *  - `oddsjam.com/game/<slug>` embeds a `__NEXT_DATA__` blob carrying the game's own identity
 *    (teams, league, kickoff) *and*, as a bonus, that sport's entire market vocabulary --
 *    `{id, label}` for every market OddsJam prices, confirmed against the live payload the same
 *    day. One visit to one game page seeds a whole sport's worth of `?market=` values.
 *
 * Both page shapes render asynchronously -- the listing page took several real seconds to populate
 * on a live check -- so this follows the same debounce/observer/interval lifecycle every other
 * injection script in this project uses rather than reading once on load.
 */

function onGamePage(): boolean {
  return /^\/game\//.test(location.pathname);
}

function onListingPage(): boolean {
  return !onGamePage() && /^\/[^/]+\/odds(?:\/|$)/i.test(location.pathname);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The `/nfl/odds` listing's own upcoming-games list -- team names only, no kickoff (see module
 *  comment). A game later visited directly backfills the kickoff via `recordGame`'s upsert. */
function readListingPage(): void {
  const sportSlug = location.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!sportSlug) return;

  for (const a of document.querySelectorAll('a[href^="/game/"]')) {
    const href = a.getAttribute("href");
    // The bare game link, not one of the market-specific variants the same listing also renders
    // (`?market=moneyline` etc.) -- those carry no more identity than this one does.
    if (!href || href.includes("?")) continue;
    const slug = href.replace(/^\/game\//, "");
    if (!slug) continue;

    const teams = Array.from(a.querySelectorAll("p"))
      .map((p) => str(p.textContent))
      .filter((t): t is string => t !== null);
    if (teams.length < 2) continue;

    void recordGame({
      sportSlug,
      slug,
      awayTeam: teams[0],
      homeTeam: teams[1],
      kickoffIso: null,
      capturedAt: Date.now(),
    });
  }
}

/** One game page: its own identity, and that sport's full market vocabulary riding along in the
 *  same `__NEXT_DATA__` payload. */
function readGamePage(): void {
  const script = document.getElementById("__NEXT_DATA__");
  if (!script?.textContent) return;

  let data: unknown;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return;
  }

  const fallback = (data as { props?: { pageProps?: { fallback?: unknown } } })?.props?.pageProps
    ?.fallback;
  if (!fallback || typeof fallback !== "object") return;
  const entries = Object.entries(fallback as Record<string, unknown>);

  const slug = location.pathname.replace(/^\/game\//, "").replace(/\/$/, "");
  if (!slug) return;

  const [, game] = entries.find(([key]) => /^game\/[^/]+$/.test(key)) ?? [];
  if (game && typeof game === "object") {
    const g = game as Record<string, unknown>;
    const sportSlug = oddsJamSportSlug(str(g.league));
    const awayTeam = str(g.awayTeam);
    const homeTeam = str(g.homeTeam);
    if (sportSlug && awayTeam && homeTeam) {
      void recordGame({
        sportSlug,
        slug,
        awayTeam,
        homeTeam,
        kickoffIso: str(g.startDate),
        capturedAt: Date.now(),
      });
    }

    const [, marketsResult] = entries.find(([key]) => /\/markets\?/.test(key)) ?? [];
    const marketsData = (marketsResult as { data?: unknown } | undefined)?.data;
    if (sportSlug && Array.isArray(marketsData)) {
      const vocabulary = marketsData.reduce<OddsJamMarketEntry[]>((out, m) => {
        const id = str((m as Record<string, unknown> | null)?.id);
        const label = str((m as Record<string, unknown> | null)?.label);
        if (id && label) out.push({ id, label });
        return out;
      }, []);
      // An empty read is more likely a shape this parses wrong than a sport with zero markets --
      // recordMarkets replaces the stored list wholesale, so writing nothing here is what protects
      // a previously good capture from being clobbered by a bad one.
      if (vocabulary.length > 0) void recordMarkets(sportSlug, vocabulary);
    }
  }
}

function inject(): void {
  try {
    if (onGamePage()) readGamePage();
    else if (onListingPage()) readListingPage();
  } catch (error) {
    console.warn("[CLV Analyzer] OddsJam capture failed:", error);
  }
}

let queued = false;
function schedule(): void {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    inject();
  }, 250);
}

/** Started by `index.ts`, which also starts the resolver -- see its own comment for the ordering. */
export function startCaptureFromPage(): void {
  inject();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // The listing page's own game list can take several real seconds to populate after the shell
  // renders; the observer is expected to catch that, and this interval is the safety net for
  // whatever it misses, same as every other injection script here.
  setInterval(schedule, 4000);
}
