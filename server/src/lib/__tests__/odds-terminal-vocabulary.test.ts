import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeOddsTerminalBookKey,
  ODDS_TERMINAL_BOOKS,
  ODDS_TERMINAL_SPORTS,
  planOddsTerminalRead,
  type MarketType,
} from "@clv/shared";

/**
 * Checks this project's Odds Terminal vocabulary against a real captured response.
 *
 * ## Why this exists
 *
 * `ODDS_TERMINAL_SPORTS`, `ODDS_TERMINAL_BOOKS` and the market tables in
 * `odds-terminal-event.ts` were written from the shape of the feed Odds Terminal proxies, not from
 * a live response -- the rest of this project's test suite proves the parser is *self-consistent*,
 * which is a different claim from "these ids are the ids the feed actually uses". A wrong id here
 * fails closed (an unrecognised league matches no fixture, an unmapped market returns nothing), so
 * the symptom is an empty tab rather than a wrong number -- but an empty tab for every market is
 * still a broken feature.
 *
 * ## This test reads files. It does not fetch anything.
 *
 * Deliberately, and permanently. The capture is made once, by hand, from a tab the user is already
 * signed into -- see the README note below. Nothing in this repository is allowed to contact Odds
 * Terminal, which `oddsjam-automation-guard.test.ts` asserts; this file must never become the
 * exception. It consumes JSON off disk and nothing else.
 *
 * ## How to produce a capture
 *
 * In a signed-in tab, DevTools -> Network, filter for `snapshot`, use the site's own UI so that
 * *its* front-end issues the request, then "Copy response" and save it as:
 *
 *     shared/src/__fixtures__/live/odds-terminal-<sport>.json
 *
 * The same for `/api/catalog?sport=<sport>`, saved as `odds-terminal-catalog-<sport>.json`, which
 * is the authoritative book list. That directory is gitignored: a real response may carry account
 * identifiers, and it is evidence for a one-off check rather than a fixture to commit.
 *
 * With no captures present every case below skips, which is the normal state of this file.
 */

const LIVE = join(__dirname, "../../../../shared/src/__fixtures__/live");

interface Capture {
  name: string;
  body: { fixtures?: unknown; odds?: unknown } & Record<string, unknown>;
}

function captures(prefix: string): Capture[] {
  if (!existsSync(LIVE)) return [];
  return readdirSync(LIVE)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((name) => ({
      name,
      body: JSON.parse(readFileSync(join(LIVE, name), "utf8")),
    }));
}

const snapshots = captures("odds-terminal-snapshot");
const catalogs = captures("odds-terminal-catalog");

/** Every distinct value of one field across an array of loosely-typed records. */
function distinct(rows: unknown, pick: (row: Record<string, unknown>) => unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const out = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = pick(row as Record<string, unknown>);
    if (typeof value === "string" && value.trim() !== "") out.add(value.trim());
  }
  return [...out].sort();
}

/** Every market id this project maps to, across every sport family. */
function mappedMarketIds(): Set<string> {
  const ids = new Set<string>();
  const markets = [
    "Passing Yards", "Rushing Yards", "Receiving Yards", "Receptions", "Passing Touchdowns",
    "Points", "Rebounds", "Assists", "Three Pointers Made", "Steals", "Blocks",
    "Hits", "Total Bases", "Home Runs", "Pitcher Strikeouts", "Batter Strikeouts",
    "Goals", "Shots On Goal", "Saves",
  ];
  for (const sport of Object.keys(ODDS_TERMINAL_SPORTS)) {
    for (const market of markets) {
      for (const type of ["PLAYER_PROP", "MONEYLINE", "SPREAD", "GAME_TOTAL"] as MarketType[]) {
        const plan = planOddsTerminalRead({ sport, statMarket: market, marketType: type });
        if (!("kind" in plan) && plan.marketId) ids.add(plan.marketId);
      }
    }
  }
  return ids;
}

describe.skipIf(snapshots.length === 0)("the captured snapshot matches our vocabulary", () => {
  it("carries player-prop markets at all", () => {
    // The decisive question, and the one that is not about spelling. `/api/snapshot` takes a sport
    // and a book list but no market parameter, so whether it returns player props is a property of
    // the endpoint. If it only ever returns game markets, the modal's default tab cannot answer the
    // questions these boards are mostly about, and no amount of respelling fixes that -- it would
    // mean a different endpoint is needed.
    for (const { name, body } of snapshots) {
      const ids = distinct(body.odds, (o) => o.market_id);
      const playerMarkets = ids.filter((id) => id.startsWith("player_"));
      expect(ids.length, `${name} returned no odds at all -- capture a live slate`).toBeGreaterThan(0);
      expect(
        playerMarkets,
        `${name} carries no player_* markets. Market ids seen: ${ids.join(", ")}`
      ).not.toEqual([]);
    }
  });

  it("uses the league ids our sport table expects", () => {
    const known = new Set(Object.values(ODDS_TERMINAL_SPORTS).map((s) => s.league));
    for (const { name, body } of snapshots) {
      const leagues = distinct(body.fixtures, (f) => {
        const league = f.league;
        return league && typeof league === "object"
          ? (league as { id?: unknown }).id
          : league;
      });
      const unknown = leagues.filter((l) => !known.has(l.toLowerCase()));
      // Not a failure on its own -- one `sport=football` snapshot legitimately carries leagues we
      // do not cover. It is reported so a *missing* one (our `nfl` never appearing) is visible.
      expect(
        leagues.some((l) => known.has(l.toLowerCase())),
        `${name} carried none of our league ids. Saw: ${leagues.join(", ")}` +
          (unknown.length ? ` (unmapped: ${unknown.join(", ")})` : "")
      ).toBe(true);
    }
  });

  it("names books our table translates, rather than falling back", () => {
    // A book that falls through to `normalizeBookKey` gets a key the user's book order, the
    // sportsbook allowlist and the outlier test have never heard of -- so it renders, but silently
    // drops out of the average. Worth knowing about explicitly.
    const unmapped: string[] = [];
    for (const { body } of snapshots) {
      const known = new Set(ODDS_TERMINAL_BOOKS.map((b) => b.name));
      for (const book of distinct(body.odds, (o) => o.sportsbook)) {
        if (!known.has(book)) {
          unmapped.push(`${book} -> ${normalizeOddsTerminalBookKey(book)}`);
        }
      }
    }
    expect(unmapped, "add these to ODDS_TERMINAL_BOOKS").toEqual([]);
  });

  it("uses market ids our tables actually map to", () => {
    // Reported in both directions. Ids present that we map nowhere are gaps to close; ids we map to
    // that never appear anywhere are probably misspelled.
    const mapped = mappedMarketIds();
    const seen = new Set<string>();
    for (const { body } of snapshots) {
      for (const id of distinct(body.odds, (o) => o.market_id)) seen.add(id);
    }
    const unmapped = [...seen].filter((id) => !mapped.has(id)).sort();
    const neverSeen = [...mapped].filter((id) => !seen.has(id)).sort();

    // eslint-disable-next-line no-console
    console.log(
      `\n[odds-terminal vocabulary]\n` +
        `  markets seen but unmapped (${unmapped.length}): ${unmapped.join(", ") || "none"}\n` +
        `  markets mapped but unseen (${neverSeen.length}): ${neverSeen.join(", ") || "none"}\n`
    );

    // Hard failure only for the wholesale case: not one id we map to appeared, which means the
    // naming convention is wrong rather than an individual market being absent from this slate.
    expect(
      [...mapped].some((id) => seen.has(id)),
      `none of our market ids appeared. Seen: ${[...seen].join(", ")}`
    ).toBe(true);
  });
});

describe.skipIf(catalogs.length === 0)("the captured catalog matches our book table", () => {
  it("lists every book we ask for", () => {
    // `oddsTerminalBooks` picks five names to put in the query. A name this catalog does not list
    // is one the endpoint will either ignore or 400 on -- and a 400 returns nothing for the whole
    // read, not just that book.
    const listed = new Set<string>();
    for (const { body } of catalogs) {
      const rows = Array.isArray(body) ? body : (body as { books?: unknown }).books ?? body;
      for (const name of distinct(rows, (b) => b.name ?? b.id)) listed.add(name);
    }
    const missing = ODDS_TERMINAL_BOOKS.map((b) => b.name).filter((b) => !listed.has(b));
    expect(
      missing,
      `these are in ODDS_TERMINAL_BOOKS but not in the catalog. Catalog lists: ${[...listed].join(", ")}`
    ).toEqual([]);
  });
});
