import { SPORTSBOOK_HINTS } from "@clv/shared";
import { prisma } from "./prisma";

const SETTINGS_ID = "singleton";

/** FanDuel first, as asked for; the rest follows the same order books.ts already ranks them in. */
export const DEFAULT_BOOK_ORDER: string[] = [...SPORTSBOOK_HINTS];

/** A book with no configured weight is treated as this -- see bookWeightsJson in schema.prisma. */
export const DEFAULT_BOOK_WEIGHT = 1;

export interface AppSettings {
  bookOrder: string[];
  useWeightedAverage: boolean;
  bookWeights: Record<string, number>;
  /** Whether captured depth weights the closing average. See useLiquidityWeighting in the schema. */
  useLiquidityWeighting: boolean;
}

function parseBookOrder(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
  };
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
function titleCase(key: string): string {
  return key.length ? key[0].toUpperCase() + key.slice(1) : key;
}

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
  for (const row of [...open, ...close]) seen.add(row.bookKey);
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
