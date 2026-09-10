import { normalizeName } from "@clv/shared";
import type { MlbMapping } from "../stat-map";
import { matchesTeam, teamsFromMatchup } from "../team-names";
import {
  candidateDates,
  fetchJson,
  type GameResult,
  type GradeSubject,
  type StatsSource,
  type ValueResult,
} from "./types";

/** MLB's official StatsAPI: free, keyless, and stable enough to be the reference source. */
interface MlbTeamRef {
  name?: string;
  teamName?: string;
  locationName?: string;
  abbreviation?: string;
}
interface MlbGame {
  gamePk: number;
  status?: { abstractGameState?: string; detailedState?: string };
  teams?: { home?: { team?: MlbTeamRef }; away?: { team?: MlbTeamRef } };
}
interface MlbSchedule {
  dates?: { games?: MlbGame[] }[];
}
interface MlbBoxPlayer {
  person?: { fullName?: string };
  stats?: { batting?: Record<string, number>; pitching?: Record<string, number> };
}
interface MlbBoxscore {
  teams?: { home?: { players?: Record<string, MlbBoxPlayer> }; away?: { players?: Record<string, MlbBoxPlayer> } };
}

const BASE = "https://statsapi.mlb.com/api/v1";

const variantsOf = (team: MlbTeamRef | undefined): string[] =>
  [team?.name, team?.teamName, team?.locationName, team?.abbreviation]
    .map((v) => normalizeName(v))
    .filter((v) => v.length > 1);

export const mlbSource: StatsSource = {
  key: "mlb",

  async findGame(subject: GradeSubject): Promise<GameResult> {
    const fromMatchup = teamsFromMatchup(subject.matchup);
    const teamA = subject.team ?? fromMatchup.a;
    const teamB = subject.opponent ?? fromMatchup.b;
    if (!teamA && !teamB) {
      return { reason: "Pick has no team or matchup text, so the game cannot be identified." };
    }

    for (const date of candidateDates(subject.gameStartTime)) {
      const day = date.toISOString().slice(0, 10);
      let schedule: MlbSchedule;
      try {
        schedule = await fetchJson<MlbSchedule>(`${BASE}/schedule?sportId=1&date=${day}`);
      } catch (error) {
        return { reason: `MLB schedule unavailable: ${error instanceof Error ? error.message : error}` };
      }

      const games = (schedule.dates ?? []).flatMap((d) => d.games ?? []);
      const hits = games.filter((game) => {
        const sets = [variantsOf(game.teams?.home?.team), variantsOf(game.teams?.away?.team)];
        const aMatch = teamA ? sets.some((v) => matchesTeam(teamA, v)) : false;
        const bMatch = teamB ? sets.some((v) => matchesTeam(teamB, v)) : false;
        return teamA && teamB ? aMatch && bMatch : aMatch || bMatch;
      });

      // Doubleheaders are the common multi-hit case and cannot be told apart from the pick alone.
      if (hits.length > 1) {
        return { reason: `Matched ${hits.length} MLB games (doubleheader?) -- refusing to guess.` };
      }
      if (hits.length === 1) {
        const game = hits[0];
        const detailed = game.status?.detailedState ?? "";
        return {
          game: {
            externalGameId: String(game.gamePk),
            isFinal: game.status?.abstractGameState === "Final",
            abandoned: /postponed|cancel|suspend/i.test(detailed),
            description: `${game.teams?.away?.team?.name} @ ${game.teams?.home?.team?.name}`,
            webUrl: `https://www.mlb.com/gameday/${game.gamePk}/final/box`,
          },
        };
      }
    }

    return { reason: `No MLB game found for "${subject.matchup ?? `${teamA} vs ${teamB}`}".` };
  },

  async getPlayerValue(gameId, subject, mapping): Promise<ValueResult> {
    const mlbMapping = mapping as MlbMapping;
    let box: MlbBoxscore;
    try {
      box = await fetchJson<MlbBoxscore>(`${BASE}/game/${gameId}/boxscore`);
    } catch (error) {
      return { reason: `MLB box score unavailable: ${error instanceof Error ? error.message : error}` };
    }

    const wanted = normalizeName(subject.player);
    const players = [
      ...Object.values(box.teams?.home?.players ?? {}),
      ...Object.values(box.teams?.away?.players ?? {}),
    ];
    const matches = players.filter((p) => normalizeName(p.person?.fullName ?? "") === wanted);

    if (matches.length === 0) {
      return { reason: `"${subject.player}" does not appear in the MLB box score for this game.` };
    }
    if (matches.length > 1) {
      return { reason: `"${subject.player}" matched ${matches.length} players -- refusing to guess.` };
    }

    const player = matches[0];

    // On a roster but with no batting and no pitching line: dressed, did not appear. Treating that
    // as zero would hand every UNDER on the player a free win.
    const batting = player.stats?.batting ?? {};
    const pitching = player.stats?.pitching ?? {};
    if (Object.keys(batting).length === 0 && Object.keys(pitching).length === 0) {
      return { didNotPlay: true, matchedName: player.person?.fullName ?? subject.player ?? "the player" };
    }

    let total = 0;
    for (const part of mlbMapping.parts) {
      // A missing field means the player did not record that stat, which is a real zero here:
      // the player is confirmed present in the box score.
      total += (part.weight ?? 1) * Number(player.stats?.[part.group]?.[part.field] ?? 0);
    }

    return {
      value: Math.round(total * 1e6) / 1e6,
      matchedName: player.person?.fullName ?? subject.player ?? "the player",
    };
  },
};
