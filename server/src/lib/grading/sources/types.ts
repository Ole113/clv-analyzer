export interface GradeSubject {
  sport: string | null;
  player: string;
  team: string | null;
  opponent: string | null;
  matchup: string | null;
  gameStartTime: Date | null;
  externalGameId: string | null;
}

export interface FoundGame {
  externalGameId: string;
  isFinal: boolean;
  /** Postponed, cancelled or suspended: there will never be a result, so the pick is VOID. */
  abandoned: boolean;
  description: string;
  /** Public box-score page, shown on the detail page so any grade can be checked in one click. */
  webUrl: string | null;
}

export type GameResult = { game: FoundGame } | { reason: string };
export type ValueResult =
  | { value: number; matchedName: string }
  | { didNotPlay: true; matchedName: string }
  | { reason: string };

export interface StatsSource {
  key: "espn" | "mlb";
  findGame(subject: GradeSubject): Promise<GameResult>;
  getPlayerValue(gameId: string, subject: GradeSubject, mapping: unknown): Promise<ValueResult>;
}

/**
 * Shared fetch for the stats sources.
 *
 * The User-Agent identifies this project honestly. That is not just etiquette: spoofing a Chrome
 * UA from Node actually gets a 403 from ESPN (the claimed browser does not match the TLS
 * fingerprint), while an honest client string returns 200. A hung request must not stall the
 * grader, hence the abort timeout.
 */
export async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "clv-analyzer/0.1 (personal CLV tracker)",
        accept: "application/json,text/plain,*/*",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Kickoff day plus neighbours: timezones and late finishes push games across date boundaries. */
export function candidateDates(gameStartTime: Date | null): Date[] {
  const base = gameStartTime ?? new Date();
  return [0, -1, 1].map((offset) => new Date(base.getTime() + offset * 86400_000));
}

export function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
