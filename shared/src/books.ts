/**
 * Which columns count toward the closing-line average.
 *
 * Only real sportsbooks do. DFS / pick'em apps are excluded because their "line" is a fixed-payout
 * pick threshold, not a market price -- averaging them in would partly compare the pick against
 * itself. Derived columns (OddsJam renders an "OddsJam Algo Odds" column) are excluded for the
 * same reason.
 *
 * Every column is still stored on the bet and shown in the snapshot tables; this only controls
 * which ones feed the average. Book keys are normalized from the column logo's alt text, verified
 * against the live OddsJam grid (2026-09): "FanDuel", "Pinnacle", "Betr Picks",
 * "Underdog Fantasy (4 Pick Flex)", "PrizePicks (5 or 6 Pick Flex)", "OddsJam Algo Odds", ...
 * Matching is therefore by substring, not equality.
 */

/**
 * Books that always count toward the closing average, checked before the pick'em exclusions.
 *
 * An allowlist is needed as well as a denylist because the pick'em hints are substrings, and real
 * sportsbook names collide with them: "BetRivers" contains "betr" (the hint for Betr Picks), so
 * without this it would be silently dropped from every average. Anything matched here is a real
 * sportsbook quoting its own market, including the social/sweepstakes books (Fliff, Rebet) and the
 * exchanges and prediction markets (Novig, Prophet X, Kalshi, Polymarket).
 */
export const SPORTSBOOK_HINTS = [
  "fanduel",
  "draftkings", // plain DraftKings; the Pick6 product is excluded by its own hint below
  "betmgm",
  "caesars",
  "pinnacle",
  "betonline",
  "bovada",
  "fliff",
  "rebet",
  "betrivers",
  "espnbet",
  "fanatics",
  "hardrock",
  "ballybet",
  "betparx",
  "bet105",
  "novig",
  "prophet",
  "circa",
  "kalshi",
  "polymarket",
  "pointsbet",
  "wynnbet",
  "superbook",
  "4cx",
  "thescore",
  // Sweepstakes books, included on the same footing as Fliff and Rebet above: they quote a real
  // market with two prices, not a fixed-payout pick threshold.
  "sportzino",
  "onyx",
];

/**
 * Peer-to-peer exchanges and prediction markets.
 *
 * These are real venues and they belong in the closing average -- but their prices are set by
 * whoever happens to have an order resting, not by a trading desk. A thin book routinely shows
 * something like -1000 on a market every sportsbook has at -150, because one person left a bad
 * order up and nobody took it. A traditional book that far off-market would have been arbitraged
 * within seconds.
 *
 * So they are held to a tighter tolerance than sportsbooks, and -- more importantly -- they are not
 * allowed to define the consensus they are measured against. See `findLineOutliers`.
 */
export const EXCHANGE_HINTS = [
  "novig",
  "prophet", // Prophet X
  "kalshi",
  "polymarket",
];

/** True when a column is an exchange or prediction market rather than a traditional sportsbook. */
export function isExchange(bookKey: string, label: string | null = null): boolean {
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;
  return EXCHANGE_HINTS.some((hint) => haystack.includes(hint));
}

/** Substrings that mark a DFS / pick'em product rather than a sportsbook. */
export const FANTASY_BOOK_HINTS = [
  "prizepicks",
  "underdog",
  "betr",
  "dabble",
  "draftkings6",
  "pick6",
  "sleeper",
  "parlayplay",
  "hotstreak",
  "boomfantasy",
  "chalkboard",
  "vividpicks",
  "thrivefantasy",
  "propsbuilder",
  "propbuilder",
];

/**
 * Fantasy apps that, unlike the rest of `FANTASY_BOOK_HINTS`, quote genuine varying two-sided
 * American odds on PropProfessor's *odds screen* rather than a fixed payout vig. PrizePicks is the
 * documented counter-example: it prices at a flat -119/-119 regardless of where the real market
 * sits, which de-vigs to an artificial 50% that would drag the average toward the middle -- that's
 * a property of the fixed payout, not a reading of the market, so it correctly stays excluded.
 * BoomFantasy and Prop Builder don't do that: a real captured close had them at -149/-143 against
 * a -142/-148/-151 sportsbook consensus -- in line with the market, not fixed. Scoped to the
 * screen path (`isSportsbookForClose`) only; the Fantasy Optimizer's own "line" for these apps is
 * still a fixed-payout pick threshold, not a market price, so `isSportsbookForAverage` is
 * unaffected.
 */
export const SCREEN_FANTASY_SPORTSBOOK_HINTS = ["boomfantasy", "propbuilder", "propsbuilder"];

/** Substrings that mark a derived/aggregate column rather than a real book. */
export const COMPUTED_COLUMN_HINTS = [
  "algo",
  "fairodds",
  "average",
  "consensus",
  // A "No-Vig Odds" column is the board's own de-vigged calculation, not the exchange named Novig.
  // The two normalize to "novigodds" and "novig", and since "novig" is a real entry in
  // SPORTSBOOK_HINTS the derived column is a substring match away from being averaged in as a book.
  // PropProfessor's fantasy parser already hard-codes `novigodds` into its reserved set for this.
  "novigodds",
  "novigline",
];

export function normalizeBookKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input
    .toLowerCase()
    .replace(/\?.*$/, "")
    .replace(/\.(png|svg|jpg|jpeg|webp|gif)$/, "")
    .replace(/^.*\//, "")
    .replace(/[^a-z0-9]/g, "");
  return cleaned.length ? cleaned : null;
}

/**
 * A column contributes to the closing average only when it is a real sportsbook quoting a line.
 * `hasLine` matters because the algo/fair column and the pick'em apps render a price with no
 * line at all -- those are dropped here regardless of name.
 */
export function isSportsbookForAverage(
  bookKey: string,
  label: string | null,
  hasLine: boolean
): boolean {
  if (!hasLine) return false;
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;

  // Known sportsbooks win outright: the pick'em hints below are substrings, and several real
  // book names contain them.
  if (SPORTSBOOK_HINTS.some((hint) => haystack.includes(hint))) {
    // ...except the DFS spin-offs of a sportsbook brand, which are pick'em products.
    if (/draftkings\s*6|pick\s*6/.test(haystack)) return false;
    return true;
  }

  if (FANTASY_BOOK_HINTS.some((hint) => haystack.includes(hint))) return false;
  if (COMPUTED_COLUMN_HINTS.some((hint) => haystack.includes(hint))) return false;
  // Unidentifiable logo columns ("col-7") stay out of the average rather than silently skewing
  // it; they are still stored and rendered in the snapshot tables.
  if (/^col-\d+$/.test(bookKey)) return false;
  return true;
}

/**
 * The same question as `isSportsbookForAverage`, but decided by allowlist only, for the odds
 * screen.
 *
 * The denylist is a safe default on the Fantasy Optimizer and an unsafe one here, and the reason is
 * that `hasLine` was doing most of the work: on the optimizer the DFS and algo columns are
 * price-only, so they were dropped on that test alone regardless of name. On an odds screen
 * essentially every column carries a line, so `isSportsbookForAverage` returns true for anything
 * not explicitly denied -- including every DFS app and derived column PropProfessor might add
 * later. Observed in the captured screen data: `OnyxOdds` and `SportZino` match no list at all and
 * would have been averaged in as real sportsbooks.
 *
 * There is a second, live bug this sidesteps. `SPORTSBOOK_HINTS` contains "novig" (the exchange)
 * and is checked *before* the `COMPUTED_COLUMN_HINTS` denylist, so a derived "No-Vig Odds" column
 * normalizes to `novigodds`, matches "novig", and returns true. PropProfessor's own fantasy parser
 * already hard-codes `novigodds` into its reserved set for exactly this reason.
 *
 * `isSportsbookForAverage` is left untouched so the optimizer path cannot regress.
 *
 * `SCREEN_FANTASY_SPORTSBOOK_HINTS` is also admitted here (see its own doc comment): a couple of
 * fantasy apps quote real market-tracking odds on this specific screen, unlike the rest of
 * `FANTASY_BOOK_HINTS`, which stay excluded exactly as before.
 */
export function isSportsbookForClose(
  bookKey: string,
  label: string | null,
  hasLine: boolean
): boolean {
  if (!hasLine) return false;
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;

  // Derived columns are rejected first here, unlike in isSportsbookForAverage, so "No-Vig Odds"
  // cannot be admitted by the "novig" sportsbook hint.
  if (COMPUTED_COLUMN_HINTS.some((hint) => haystack.includes(hint))) return false;
  // An explicit alt-line column is a real book quoting a deliberately off-market number; the
  // main-line reconstruction already found that book's real line from its own selections.
  if (/\balt\b/.test(`${bookKey.toLowerCase()} ${(label ?? "").toLowerCase()}`)) return false;
  if (/draftkings\s*6|pick\s*6/.test(haystack)) return false;

  return (
    SPORTSBOOK_HINTS.some((hint) => haystack.includes(hint)) ||
    SCREEN_FANTASY_SPORTSBOOK_HINTS.some((hint) => haystack.includes(hint))
  );
}

/** True when a column is a DFS / pick'em product rather than a sportsbook. */
export function isFantasyBook(bookKey: string, label: string | null): boolean {
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;
  return FANTASY_BOOK_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Where each book's icon comes from, keyed by normalized book key.
 *
 * The DOM parsers get a logo for free -- the board renders one and `logoUrl` is scraped off the
 * `<img>`. The odds screen is JSON and carries no images at all, so every row read through
 * `sources/propprofessor-screen.ts` came back logo-less and the Odds modal rendered a wall of bare
 * text next to numbers the snapshot tables show with icons. This maps the book names the screen
 * actually returns (verified against the captured fixtures in `src/__fixtures__/`) onto the domain
 * whose favicon is that book's icon, and the favicon is fetched through Google's proxy rather than
 * each book's own CDN path -- that path is scraped from a live DOM on the parser paths, and nothing
 * here has a stable copy of it.
 *
 * A book missing from this map simply renders without an icon, exactly as before.
 */
const BOOK_DOMAINS: Record<string, string> = {
  fanduel: "fanduel.com",
  draftkings: "draftkings.com",
  draftkings6: "draftkings.com",
  betmgm: "betmgm.com",
  // The sportsbook subdomain, not the parent casino group: caesars.com's favicon is the Caesars
  // Entertainment crown rather than the sportsbook app's icon.
  caesars: "sportsbook.caesars.com",
  pinnacle: "pinnacle.com",
  betonline: "betonline.ag",
  bovada: "bovada.lv",
  fliff: "getfliff.com",
  rebet: "rebet.app",
  betrivers: "betrivers.com",
  espnbet: "espnbet.com",
  fanatics: "fanatics.com",
  hardrock: "hardrock.bet",
  ballybet: "ballybet.com",
  betparx: "betparx.com",
  novig: "novig.us",
  prophetx: "prophetx.co",
  prophet: "prophetx.co",
  circa: "circasports.com",
  kalshi: "kalshi.com",
  polymarket: "polymarket.com",
  polymarketus: "polymarket.com",
  pointsbet: "pointsbet.com",
  superbook: "superbook.com",
  thescore: "thescore.bet",
  sportzino: "sportzino.com",
  onyxodds: "onyxodds.com",
  prizepicks: "prizepicks.com",
  underdog: "underdogfantasy.com",
  betr: "betr.app",
  dabble: "dabble.com",
  sleeper: "sleeper.com",
  parlayplay: "parlayplay.io",
  boomfantasy: "boomfantasy.com",
  chalkboard: "chalkboard.io",
  propbuilder: "propbuilder.com",
  propsbuilder: "propbuilder.com",
};

/**
 * A book's icon URL, or null when we have no domain for it.
 *
 * Matching is by longest key first, for the same reason `isSportsbookForAverage` checks its
 * allowlist before the pick'em hints: the keys are substrings of one another. "draftkings6"
 * contains "draftkings", and an alt-line column normalizes to "betralt", which must still find
 * "betr" -- but "betrivers" must not be answered by "betr".
 */
const BOOK_DOMAIN_KEYS = Object.keys(BOOK_DOMAINS).sort((a, b) => b.length - a.length);

export function bookLogoUrl(bookKey: string, label: string | null = null): string | null {
  const normalized = normalizeBookKey(bookKey) ?? "";
  const fromLabel = normalizeBookKey(label) ?? "";
  for (const candidate of [normalized, fromLabel]) {
    if (!candidate) continue;
    const exact = BOOK_DOMAINS[candidate];
    if (exact) return faviconUrl(exact);
  }
  for (const key of BOOK_DOMAIN_KEYS) {
    if (normalized.startsWith(key) || fromLabel.startsWith(key)) return faviconUrl(BOOK_DOMAINS[key]);
  }
  return null;
}

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}
