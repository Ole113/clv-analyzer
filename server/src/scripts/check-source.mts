/**
 * Live check of the stats adapters against known-good fixtures.
 * Run: npx tsx src/scripts/check-source.mts
 */
import { espnSource } from "../lib/grading/sources/espn";
import { mlbSource } from "../lib/grading/sources/mlb";
import { resolveMapping } from "../lib/grading/stat-map";
import { settle } from "../lib/grading/grade";
import type { Side } from "../lib/constants";

interface Fixture {
  label: string;
  sport: string;
  player: string;
  team: string;
  opponent: string;
  matchup: string;
  date: string;
  statMarket: string;
  side: Side;
  takenLine: number;
  expectValue: number;
  expectResult: string;
}

const FIXTURES: Fixture[] = [
  {
    label: "NFL receiving yards",
    sport: "NFL", player: "Puka Nacua",
    team: "Los Angeles Rams", opponent: "Houston Texans",
    matchup: "Los Angeles Rams vs Houston Texans", date: "2025-09-07T20:00:00Z",
    statMarket: "Player Receiving Yards", side: "OVER", takenLine: 62.5,
    expectValue: 130, expectResult: "WIN",
  },
  {
    label: "NFL receptions (Under)",
    sport: "NFL", player: "Puka Nacua",
    team: "Los Angeles Rams", opponent: "Houston Texans",
    matchup: "Los Angeles Rams vs Houston Texans", date: "2025-09-07T20:00:00Z",
    statMarket: "Player Receptions", side: "UNDER", takenLine: 6.5,
    expectValue: 10, expectResult: "LOSS",
  },
  {
    label: "MLB composite (H+R+RBI)",
    sport: "MLB", player: "Daniel Schneemann",
    team: "Cleveland Guardians", opponent: "Kansas City Royals",
    matchup: "Kansas City Royals vs Cleveland Guardians", date: "2025-09-08T22:00:00Z",
    statMarket: "Hits + Runs + RBIs", side: "OVER", takenLine: 2.5,
    expectValue: 7, expectResult: "WIN",
  },
  {
    label: "NCAAF (location-style team name)",
    sport: "NCAAF", player: "Julian Sayin",
    team: "Ohio State", opponent: "Grambling",
    matchup: "Ohio State vs Grambling", date: "2025-09-06T16:00:00Z",
    statMarket: "Player Passing Completions", side: "OVER", takenLine: 15.5,
    expectValue: -1, expectResult: "?",
  },
];

let failures = 0;
for (const f of FIXTURES) {
  const subject = {
    sport: f.sport, player: f.player, team: f.team, opponent: f.opponent,
    matchup: f.matchup, gameStartTime: new Date(f.date), externalGameId: null,
  };
  const { mapping, reason } = resolveMapping(f.sport, f.statMarket);
  if (!mapping) { console.log(`FAIL ${f.label}: unmapped -- ${reason}`); failures++; continue; }

  const source = mapping.source === "mlb" ? mlbSource : espnSource;
  const found = await source.findGame(subject);
  if ("reason" in found) { console.log(`FAIL ${f.label}: ${found.reason}`); failures++; continue; }

  const got = await source.getPlayerValue(found.game.externalGameId, subject, mapping);
  if ("reason" in got) { console.log(`FAIL ${f.label}: ${got.reason}`); failures++; continue; }

  const result = settle(f.side, f.takenLine, got.value);
  const ok = f.expectValue < 0 || (got.value === f.expectValue && result === f.expectResult);
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${f.label}: ${found.game.description} [${found.game.isFinal ? "final" : "not final"}] ` +
      `-> ${got.matchedName} = ${got.value} | ${f.side} ${f.takenLine} => ${result}` +
      (f.expectValue < 0 ? "  (exploratory)" : "")
  );
}
console.log(failures === 0 ? "\nall fixtures passed" : `\n${failures} fixture(s) failed`);
