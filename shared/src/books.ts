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

  return SPORTSBOOK_HINTS.some((hint) => haystack.includes(hint));
}

/** True when a column is a DFS / pick'em product rather than a sportsbook. */
export function isFantasyBook(bookKey: string, label: string | null): boolean {
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;
  return FANTASY_BOOK_HINTS.some((hint) => haystack.includes(hint));
}
