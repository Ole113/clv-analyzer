import { normalizeName } from "@clv/shared";
import { ESPN_SPORT_PATHS, parseStatCell, type EspnMapping } from "../stat-map";
import { matchesTeam, teamVariants, teamsFromMatchup } from "../team-names";
import {
  candidateDates,
  fetchJson,
  yyyymmdd,
  type GameResult,
  type GradeSubject,
  type StatsSource,
  type ValueResult,
} from "./types";

/** Shapes are narrowed to only what grading reads; ESPN sends far more. */
interface EspnTeam {
  displayName?: string;
  shortDisplayName?: string;
  location?: string;
  abbreviation?: string;
  name?: string;
}
interface EspnEvent {
  id: string;
  name?: string;
  status?: { type?: { name?: string; completed?: boolean } };
  competitions?: { competitors?: { team?: EspnTeam }[] }[];
}
interface EspnScoreboard {
  events?: EspnEvent[];
}
interface EspnAthlete {
  athlete?: { displayName?: string; shortName?: string };
  stats?: string[];
  didNotPlay?: boolean;
}
interface EspnCategory {
  name?: string;
  labels?: string[];
  athletes?: EspnAthlete[];
}
interface EspnSummary {
  boxscore?: { players?: { statistics?: EspnCategory[] }[] };
}

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

/** Statuses that mean the game will never produce a stat line. */
const ABANDONED = new Set(["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_SUSPENDED"]);

const WEB_PATH: Record<string, string> = {
  "football/nfl": "nfl",
  "football/college-football": "college-football",
  "basketball/nba": "nba",
};

/** A player whose whole line is blank/"--" was dressed but recorded nothing readable. */
function hasNoStatLine(athlete: EspnAthlete): boolean {
  const stats = athlete.stats ?? [];
  if (stats.length === 0) return true;
  return stats.every((cell) => {
    const text = String(cell ?? "").trim();
    return text === "" || text === "-" || text === "--";
  });
}

function sportPath(sport: string | null): string | null {
  return ESPN_SPORT_PATHS[normalizeName(sport)] ?? null;
}

export const espnSource: StatsSource = {
  key: "espn",

  async findGame(subject: GradeSubject): Promise<GameResult> {
    const path = sportPath(subject.sport);
    if (!path) return { reason: `No ESPN sport path for "${subject.sport}".` };

    const fromMatchup = teamsFromMatchup(subject.matchup);
    const teamA = subject.team ?? fromMatchup.a;
    const teamB = subject.opponent ?? fromMatchup.b;
    if (!teamA && !teamB) {
      return { reason: "Pick has no team or matchup text, so the game cannot be identified." };
    }

    for (const date of candidateDates(subject.gameStartTime)) {
      let board: EspnScoreboard;
      try {
        board = await fetchJson<EspnScoreboard>(`${BASE}/${path}/scoreboard?dates=${yyyymmdd(date)}`);
      } catch (error) {
        return { reason: `ESPN scoreboard unavailable: ${error instanceof Error ? error.message : error}` };
      }

      const hits: EspnEvent[] = [];
      for (const event of board.events ?? []) {
        const competitors = event.competitions?.[0]?.competitors ?? [];
        const variantSets = competitors.map((c) => teamVariants(c.team ?? {}));
        const aMatch = teamA ? variantSets.some((v) => matchesTeam(teamA, v)) : false;
        const bMatch = teamB ? variantSets.some((v) => matchesTeam(teamB, v)) : false;
        // Both sides when both are known -- a single-team match could be the wrong week's game.
        if (teamA && teamB ? aMatch && bMatch : aMatch || bMatch) hits.push(event);
      }

      if (hits.length > 1) {
        return {
          reason: `Matched ${hits.length} ESPN games for "${subject.matchup ?? `${teamA} / ${teamB}`}" -- refusing to guess.`,
        };
      }
      if (hits.length === 1) {
        const event = hits[0];
        const type = event.status?.type;
        return {
          game: {
            externalGameId: event.id,
            // `completed` is the field that means what we need: STATUS_FINAL_OVERTIME and the
            // college variants are all final too, and a name comparison would miss them.
            isFinal: type?.completed === true || type?.name === "STATUS_FINAL",
            abandoned: ABANDONED.has(type?.name ?? ""),
            description: event.name ?? event.id,
            webUrl: WEB_PATH[path]
              ? `https://www.espn.com/${WEB_PATH[path]}/boxscore/_/gameId/${event.id}`
              : null,
          },
        };
      }
    }

    return {
      reason: `No ESPN game found for "${subject.matchup ?? `${teamA} vs ${teamB}`}" around ${
        subject.gameStartTime?.toISOString().slice(0, 10) ?? "unknown date"
      }.`,
    };
  },

  async getPlayerValue(gameId, subject, mapping): Promise<ValueResult> {
    const path = sportPath(subject.sport);
    if (!path) return { reason: `No ESPN sport path for "${subject.sport}".` };
    const espnMapping = mapping as EspnMapping;

    let summary: EspnSummary;
    try {
      summary = await fetchJson<EspnSummary>(`${BASE}/${path}/summary?event=${gameId}`);
    } catch (error) {
      return { reason: `ESPN box score unavailable: ${error instanceof Error ? error.message : error}` };
    }

    const teams = summary.boxscore?.players ?? [];
    if (teams.length === 0) return { reason: "ESPN returned no box score for this game yet." };

    const wanted = normalizeName(subject.player);
    let total = 0;
    let matchedName: string | null = null;

    for (const part of espnMapping.parts) {
      const rows: { name: string; raw: string; didNotPlay: boolean }[] = [];

      for (const team of teams) {
        for (const category of team.statistics ?? []) {
          // "*" means the sport has a single box-score category (basketball).
          if (part.category !== "*" && category.name !== part.category) continue;
          const labelIndex = (category.labels ?? []).indexOf(part.label);
          // Labels are matched by name: NCAAF drops TGTS from receiving, so a fixed index would
          // read a different column for college games.
          if (labelIndex === -1) continue;

          for (const athlete of category.athletes ?? []) {
            const name = athlete.athlete?.displayName ?? "";
            if (normalizeName(name) !== wanted) continue;
            rows.push({
              name,
              raw: athlete.stats?.[labelIndex] ?? "",
              didNotPlay: athlete.didNotPlay === true || hasNoStatLine(athlete),
            });
          }
        }
      }

      if (rows.length === 0) {
        // Three very different situations look alike here, and conflating them is how an
        // inactive player silently hands every UNDER on him a free win:
        //   1. dressed and recorded nothing in THIS category (a QB with no carries) -> a real zero
        //   2. did not play at all -> VOID, not zero
        //   3. not in the box score -> the player match failed, not a result
        const appearances = teams.flatMap((team) =>
          (team.statistics ?? []).flatMap((category) =>
            (category.athletes ?? []).filter(
              (a) => normalizeName(a.athlete?.displayName ?? "") === wanted
            )
          )
        );
        if (appearances.length === 0) {
          return { reason: `"${subject.player}" does not appear in the ESPN box score for this game.` };
        }
        if (appearances.every((a) => a.didNotPlay === true || hasNoStatLine(a))) {
          return {
            didNotPlay: true,
            matchedName: appearances[0].athlete?.displayName ?? subject.player,
          };
        }
        continue; // genuinely zero for this category
      }
      if (rows.length > 1) {
        return { reason: `"${subject.player}" matched ${rows.length} box-score rows -- refusing to guess.` };
      }

      if (rows[0].didNotPlay) {
        return { didNotPlay: true, matchedName: rows[0].name };
      }
      const value = parseStatCell(rows[0].raw, part.transform);
      if (value === null) {
        return { reason: `Could not read "${part.label}" for ${rows[0].name} (raw: "${rows[0].raw}").` };
      }
      total += value;
      matchedName = rows[0].name;
    }

    if (matchedName === null) {
      return { reason: `"${subject.player}" has no values for this market in the ESPN box score.` };
    }
    return { value: Math.round(total * 1e6) / 1e6, matchedName };
  },
};
