import { normalizeName } from "@clv/shared";

/**
 * Team matching without fuzzy guesswork.
 *
 * ESPN publishes several names per team -- displayName ("Ohio State Buckeyes"), location
 * ("Ohio State"), shortDisplayName ("Buckeyes") and abbreviation ("OSU"). The boards use
 * displayName for pro leagues and location for college, so comparing a normalized board name
 * against the whole variant set covers both without similarity scoring.
 */
export function teamVariants(team: {
  displayName?: string;
  shortDisplayName?: string;
  location?: string;
  abbreviation?: string;
  name?: string;
}): string[] {
  return [team.displayName, team.location, team.shortDisplayName, team.name, team.abbreviation]
    .map((v) => normalizeName(v))
    .filter((v) => v.length > 1);
}

export function matchesTeam(boardName: string | null, variants: string[]): boolean {
  const name = normalizeName(boardName);
  if (!name) return false;
  if (variants.includes(name)) return true;
  // "Los Angeles Rams" vs location "Los Angeles" + name "Rams": accept when a variant is a whole
  // word-run inside the board name, which avoids "Jets" matching "New York Giants".
  return variants.some((v) => v.length > 3 && (name.includes(v) || v.includes(name)));
}

/** Splits "Team A vs Team B" / "Team A @ Team B" when the row gave no explicit team fields. */
export function teamsFromMatchup(matchup: string | null): { a: string | null; b: string | null } {
  if (!matchup) return { a: null, b: null };
  const parts = matchup.split(/\s+(?:vs\.?|@|at)\s+/i);
  return parts.length === 2 ? { a: parts[0].trim(), b: parts[1].trim() } : { a: null, b: null };
}
