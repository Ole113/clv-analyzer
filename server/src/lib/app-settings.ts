import { DEFAULT_KELLY_BOARDS, DEFAULT_KELLY_MULTIPLIER } from "@clv/shared";
import { prisma } from "./prisma";

const SETTINGS_ID = "singleton";

/**
 * The book column order a fresh install starts with, and what Settings restores on a reset.
 *
 * Hand-curated rather than derived. This used to be `[...SPORTSBOOK_HINTS]`, which put FanDuel
 * first and otherwise inherited whatever order the allowlist in `books.ts` happened to be written
 * in -- a stand-in for a real preference, because at the time there was no real preference to use.
 * There is now: this is the order arrived at by reordering the list on the Settings page, promoted
 * here so every install starts from it instead of from the allowlist's incidental order.
 *
 * Roughly: the books worth reading first (Circa, FanDuel, Pinnacle), then the rest of the
 * sportsbooks and exchanges, then the DFS / pick'em apps and the derived and alt-line columns,
 * which are shown but never averaged. A stored order overrides this entirely, and any book not
 * named here still gets a row -- `sortByBookOrder` puts unranked books after the ranked ones, so a
 * newly-seen book appears at the end rather than vanishing.
 */
export const DEFAULT_BOOK_ORDER: string[] = [
  "circa",
  "fanduel",
  "pinnacle",
  "propsbuilder",
  "propbuilder",
  "betonline",
  "novig",
  "novigapp",
  "draftkings",
  "polymarketus",
  "polymarket",
  "prophet",
  "kalshi",
  "4cx",
  "betmgm",
  "caesars",
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
  "pointsbet",
  "wynnbet",
  "superbook",
  "thescore",
  "sportzino",
  "onyx",
  "prizepicks",
  "courtside",
  "oddsjamalgoodds",
  "dogghouse",
  "prizepicks5or6pickflex",
  "parlayplay",
  "betrpicks",
  "dabble3or5pick",
  "underdogfantasy4pickflex",
  "betr",
  "dabble",
  "sleeper",
  "underdog",
  "chalkboard",
  "betralt",
  "boomfantasy",
  "onyxodds",
  "underdogalt",
  "draftkings6",
  "draftkings6alt",
  "dabblealt",
  "hotstreak",
];

/** A book with no configured weight is treated as this -- see bookWeightsJson in schema.prisma. */
export const DEFAULT_BOOK_WEIGHT = 1;

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  bookOrder: string[];
  useWeightedAverage: boolean;
  bookWeights: Record<string, number>;
  /** Whether captured depth weights the closing average. See useLiquidityWeighting in the schema. */
  useLiquidityWeighting: boolean;
  themePreference: ThemePreference;
  /**
   * The Odds API key for the Odds modal's second source. Empty string means "not configured",
   * which that tab says out loud rather than disappearing -- a hidden tab is indistinguishable
   * from a missing feature.
   */
  oddsApiKey: string;
  /**
   * Kelly staking, read by two surfaces: the /kelly page and the extension's Kelly button on
   * OddsJam's bet tracker. Dollars here, whole cents in the database -- see the schema.
   */
  kelly: KellySettings;
}

export interface KellySettings {
  /** In dollars. 0 means "not set yet", which both surfaces say out loud rather than guessing. */
  bankroll: number;
  kellyMultiplier: number;
  /** In dollars. 0 means 1% of bankroll. */
  unitSize: number;
  /** OddsJam board slugs that get the Kelly button. */
  kellyBoards: string[];
}

function parseTheme(raw: string): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** Splits either of the comma-separated lists stored here, tolerating stray spaces and blanks. */
function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBookOrder(raw: string): string[] {
  return parseList(raw);
}

function parseWeights(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Cents to dollars, treating anything that is not a number as zero.
 *
 * The guard is not paranoia: a running process holding a Prisma client generated before these
 * columns existed selects a row without them, and `undefined / 100` is NaN, which serializes to
 * `null` over the wire and renders as "$NaN" on screen. Zero reads as "not set yet", which is both
 * true and harmless.
 */
function dollars(cents: number | null | undefined): number {
  return typeof cents === "number" && Number.isFinite(cents) ? cents / 100 : 0;
}

/** Reads the single settings row, creating it with defaults on first use. */
export async function getAppSettings(): Promise<AppSettings> {
  const row = await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID, bookOrder: DEFAULT_BOOK_ORDER.join(",") },
  });
  const bookOrder = row.bookOrder ? parseBookOrder(row.bookOrder) : DEFAULT_BOOK_ORDER;
  return {
    bookOrder,
    useWeightedAverage: row.useWeightedAverage,
    bookWeights: parseWeights(row.bookWeightsJson),
    useLiquidityWeighting: row.useLiquidityWeighting,
    themePreference: parseTheme(row.themePreference),
    // Guarded the same way the cent columns are: a process holding a Prisma client generated
    // before this column existed selects a row without it, and `undefined` would reach `fetch` as
    // the string "undefined" rather than failing the "no key configured" check.
    oddsApiKey: typeof row.oddsApiKey === "string" ? row.oddsApiKey.trim() : "",
    kelly: {
      bankroll: dollars(row.bankrollCents),
      kellyMultiplier:
        typeof row.kellyMultiplier === "number" && row.kellyMultiplier > 0
          ? row.kellyMultiplier
          : DEFAULT_KELLY_MULTIPLIER,
      unitSize: dollars(row.unitSizeCents),
      // An empty column means "never edited", not "no boards" -- the defaults are what a fresh
      // install should behave like, and blanking the field on the Settings page restores them.
      kellyBoards: row.kellyBoards ? parseList(row.kellyBoards) : [...DEFAULT_KELLY_BOARDS],
    },
  };
}

/**
 * Saves the Kelly numbers.
 *
 * Money arrives in dollars and is stored in cents, rounded once here so the rounding happens in
 * exactly one place. A blank board list is stored blank rather than as the defaults spelled out,
 * so that a later change to the defaults reaches an install that never edited them.
 */
export async function saveKellySettings(settings: {
  bankroll: number;
  kellyMultiplier: number;
  unitSize: number;
  kellyBoards: string[];
}): Promise<void> {
  const data = {
    bankrollCents: Math.max(0, Math.round(settings.bankroll * 100)),
    kellyMultiplier:
      Number.isFinite(settings.kellyMultiplier) && settings.kellyMultiplier > 0
        ? settings.kellyMultiplier
        : DEFAULT_KELLY_MULTIPLIER,
    unitSizeCents: Math.max(0, Math.round(settings.unitSize * 100)),
    kellyBoards: settings.kellyBoards.map((b) => b.trim()).filter(Boolean).join(","),
  };
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, bookOrder: DEFAULT_BOOK_ORDER.join(","), ...data },
  });
}

/**
 * Saves (or clears) the Odds API key.
 *
 * Trimmed because it is pasted, and a trailing newline off a clipboard would otherwise be sent as
 * part of the key and rejected as invalid with no visible cause. An empty string is stored as
 * such and read back as "not configured", which is how the key is removed.
 */
export async function saveOddsApiKey(key: string): Promise<void> {
  const oddsApiKey = key.trim();
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { oddsApiKey },
    create: { id: SETTINGS_ID, bookOrder: DEFAULT_BOOK_ORDER.join(","), oddsApiKey },
  });
}

export async function saveThemePreference(themePreference: ThemePreference): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { themePreference },
    create: { id: SETTINGS_ID, bookOrder: DEFAULT_BOOK_ORDER.join(","), themePreference },
  });
}

export async function saveBookOrder(order: string[]): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { bookOrder: order.join(",") },
    create: { id: SETTINGS_ID, bookOrder: order.join(",") },
  });
}

export async function saveBookWeights(
  weights: Record<string, number>,
  useWeightedAverage: boolean,
  useLiquidityWeighting = false
): Promise<void> {
  const bookWeightsJson = JSON.stringify(weights);
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { bookWeightsJson, useWeightedAverage, useLiquidityWeighting },
    create: {
      id: SETTINGS_ID,
      bookOrder: DEFAULT_BOOK_ORDER.join(","),
      bookWeightsJson,
      useWeightedAverage,
      useLiquidityWeighting,
    },
  });
}

/** Title-cases a bare book key ("fanduel" -> "Fanduel") for when no captured label exists. */
/** Splits on hyphens/underscores first ("dogg-house" -> "Dogg House") -- a raw book key is
 *  kebab- or snake-cased, not one word, so capitalizing only the first letter left the rest
 *  of a multi-word key lowercase and hyphenated. */
export function titleCase(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * PropProfessor grid columns the parser now excludes from book detection (shared/src/parsers/
 * propprofessor.ts's `reserved` set) -- kept as a second, small copy here rather than imported,
 * since that file must stay self-contained for `Function.prototype.toString()` serialization at
 * closing time. Rows already captured under one of these keys, from before that fix landed,
 * would otherwise keep showing up as orderable/weightable "books" forever.
 */
const NON_BOOK_KEYS = new Set(["participant", "line", "selectiontype"]);

/**
 * Every distinct book key ever seen, on top of the built-in defaults -- so a book the boards
 * started quoting after the defaults were written still gets an orderable, weightable row. Each
 * one carries a human label, preferring whatever the board itself supplied over the bare key.
 */
export async function knownBooks(): Promise<{ bookKey: string; label: string }[]> {
  const [open, close] = await Promise.all([
    prisma.openLine.findMany({
      distinct: ["bookKey"],
      select: { bookKey: true, label: true },
      orderBy: { id: "desc" },
    }),
    prisma.closeLine.findMany({
      distinct: ["bookKey"],
      select: { bookKey: true, label: true },
      orderBy: { id: "desc" },
    }),
  ]);
  const labels = new Map<string, string>();
  for (const row of [...open, ...close]) {
    if (row.label && !labels.has(row.bookKey)) labels.set(row.bookKey, row.label);
  }
  const seen = new Set<string>(DEFAULT_BOOK_ORDER);
  for (const row of [...open, ...close]) {
    if (!NON_BOOK_KEYS.has(row.bookKey.toLowerCase())) seen.add(row.bookKey);
  }
  return [...seen].map((bookKey) => ({ bookKey, label: labels.get(bookKey) ?? titleCase(bookKey) }));
}

/**
 * Sorts book rows by the configured order. Books not in the list keep their relative order and
 * are appended after every book that is, so a newly-seen book is never hidden -- just unsorted.
 */
export function sortByBookOrder<T extends { bookKey: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.bookKey);
    const rb = rank.get(b.bookKey);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}
