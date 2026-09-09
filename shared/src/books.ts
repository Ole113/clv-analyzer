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
];

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

/** True when a column is a DFS / pick'em product rather than a sportsbook. */
export function isFantasyBook(bookKey: string, label: string | null): boolean {
  const haystack = `${bookKey.toLowerCase()} ${normalizeBookKey(label) ?? ""}`;
  return FANTASY_BOOK_HINTS.some((hint) => haystack.includes(hint));
}
