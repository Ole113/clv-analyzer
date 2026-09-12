"use client";

import { useMemo, useState } from "react";
import type { listBets } from "@/lib/queries";
import { VerdictBadge, ResultBadge, fmtDateTime, fmtOdds, sideLabel, betTitle } from "@/components/ui";
import { BetRow } from "@/components/bet-row";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";
import { useBetContextMenu } from "@/components/bet-context-menu";

type Bet = Awaited<ReturnType<typeof listBets>>[number] & {
  boardUrl: string;
  oddsScreenUrl: { url: string; filteredTo: string };
};

type SortKey = "kickoff" | "taken" | "avgClose" | "edge" | "ev" | "actual";
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

/** Value each sortable column actually sorts on -- the raw number/date, not its formatted text. */
function sortValue(b: Bet, key: SortKey): number | null {
  switch (key) {
    case "kickoff":
      return b.gameStartTime ? b.gameStartTime.getTime() : null;
    case "taken":
      return b.takenLine;
    case "avgClose":
      return b.avgClosingLine;
    case "edge":
      return b.edge;
    case "ev":
      return b.closeEvPercent ?? b.openEvPercent;
    case "actual":
      return b.actualValue;
  }
}

/** Nulls sort last regardless of direction -- "no value yet" is not meaningfully high or low. */
function compareBets(a: Bet, b: Bet, sort: Sort): number {
  if (!sort) return 0;
  const av = sortValue(a, sort.key);
  const bv = sortValue(b, sort.key);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return sort.dir === "asc" ? av - bv : bv - av;
}

function SortIndicator({ dir }: { dir: "asc" | "desc" }) {
  return <span className="sort-indicator">{dir === "asc" ? " ▲" : " ▼"}</span>;
}

function SortableTh({
  sortKey,
  sort,
  onSort,
  children,
}: {
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      className="num sortable"
      role="button"
      tabIndex={0}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
    >
      {children}
      {active && <SortIndicator dir={sort!.dir} />}
    </th>
  );
}

const DAY_STATUSES = {
  waiting: new Set(["PENDING", "DUE", "NEEDS_GAME_TIME"]),
};

function dayKey(b: Bet): string {
  const when = b.gameStartTime ?? b.openCapturedAt;
  return when ? when.toISOString().slice(0, 10) : "unknown";
}

function formatDayHeading(key: string): string {
  if (key === "unknown") return "No date";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDate();
  const ordinal = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${date.toLocaleDateString(undefined, { month: "long" })} ${day}${ordinal}`;
}

function dayCounts(rows: Bet[]): { waiting: number; settled: number; graded: number } {
  let waiting = 0;
  let settled = 0;
  let graded = 0;
  for (const b of rows) {
    if (b.status === "CLOSED") settled++;
    if (DAY_STATUSES.waiting.has(b.status)) waiting++;
    if (b.gradeResult === "WIN" || b.gradeResult === "LOSS") graded++;
  }
  return { waiting, settled, graded };
}

export function BetsTable({ bets }: { bets: Bet[] }) {
  const [sort, setSort] = useState<Sort>(null);
  const [groupByDay, setGroupByDay] = useState(false);
  const { openContextMenu, contextMenuElement } = useBetContextMenu();

  const onSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  const sorted = useMemo(() => {
    if (!sort) return bets;
    return [...bets].sort((a, b) => compareBets(a, b, sort));
  }, [bets, sort]);

  const groups = useMemo(() => {
    if (!groupByDay) return null;
    const byDay = new Map<string, Bet[]>();
    for (const b of sorted) {
      const key = dayKey(b);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(b);
    }
    // Chronological -- soonest day first, so "what's upcoming" reads top to bottom.
    return [...byDay.entries()].sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : a.localeCompare(b)));
  }, [sorted, groupByDay]);

  const head = (
    <tr>
      <th>Pick</th>
      <th>Market</th>
      <th>Side</th>
      <SortableTh sortKey="taken" sort={sort} onSort={onSort}>
        Taken
      </SortableTh>
      <SortableTh sortKey="avgClose" sort={sort} onSort={onSort}>
        Avg close
        <Info title="Average closing line" anchor="consensus">
          The mean closing line across the real sportsbooks still quoting this prop. Pick&apos;em
          apps and derived columns are excluded. The count in brackets is how many books went into
          it.
        </Info>
      </SortableTh>
      <SortableTh sortKey="edge" sort={sort} onSort={onSort}>
        Edge
        <Info title="CLV edge" anchor="clv">
          How far the line moved in your favour, in line units. Over: closing minus taken. Under:
          taken minus closing. Positive means you beat the close.
        </Info>
      </SortableTh>
      <SortableTh sortKey="ev" sort={sort} onSort={onSort}>
        EV%
        <Info title="Expected value" anchor="ev">
          <code>fair probability × decimal payout − 1</code>, using the site&apos;s own no-vig
          probability at your line.
        </Info>
      </SortableTh>
      <SortableTh sortKey="actual" sort={sort} onSort={onSort}>
        Actual
        <Info title="Actual result" anchor="grading">
          What the player actually recorded, read from the official box score after the game
          finished, shown against the line you took.
        </Info>
      </SortableTh>
      <SortableTh sortKey="kickoff" sort={sort} onSort={onSort}>
        Kickoff
      </SortableTh>
      <th>Board</th>
      <th>CLV</th>
      <th>Result</th>
    </tr>
  );

  const row = (b: Bet) => (
    <BetRow
      key={b.id}
      id={b.id}
      label={betTitle(b)}
      onContextMenu={(e) => openContextMenu(e, b.id, betTitle(b))}
    >
      <td>
        <a href={`/bets/${b.id}`}>{b.player ?? b.selectionName ?? b.statMarket}</a>
        <div className="muted" style={{ fontSize: 12 }}>
          {b.matchup ?? b.sport ?? ""}
          {b.isLive && <span className="live-chip">LIVE</span>}
        </div>
      </td>
      <td>{b.statMarket}</td>
      <td>{sideLabel(b.side) || <span className="muted">--</span>}</td>
      {/* A moneyline's "line" is itself an American-odds price -- +130, not 130 -- so it gets the
          same explicit sign every other price in the app does. */}
      <td className="num">{b.marketType === "MONEYLINE" ? fmtOdds(b.takenLine) : b.takenLine}</td>
      <td className="num">
        {b.avgClosingLine === null ? (
          <span className="muted">--</span>
        ) : (
          <>
            {b.marketType === "MONEYLINE" ? fmtOdds(Math.round(b.avgClosingLine)) : b.avgClosingLine.toFixed(2)}
            {b.closingBookCount ? <span className="muted" style={{ fontSize: 11 }}> ({b.closingBookCount})</span> : null}
          </>
        )}
      </td>
      <td className="num">
        <Signed value={b.edge} />
      </td>
      <td className="num">
        <Signed value={b.closeEvPercent ?? b.openEvPercent} unit="%" />
      </td>
      <td className="num">
        {b.actualValue === null ? (
          <span className="muted">--</span>
        ) : (
          <>
            {b.actualValue}
            {/* A spread's actual is the bet team's margin, measured against the negated handicap.
                A moneyline's actual is also a margin, but with no handicap -- it settles against 0,
                not the taken price -- so showing takenLine (a price, not a margin) here would
                misread just as badly. */}
            <span className="muted" style={{ fontSize: 11 }}>
              {" "}
              /{" "}
              {b.marketType === "SPREAD" ? -b.takenLine : b.marketType === "MONEYLINE" ? 0 : b.takenLine}
            </span>
          </>
        )}
      </td>
      <td>{fmtDateTime(b.gameStartTime)}</td>
      <td>
        <a
          className="ext"
          href={b.boardUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open this board on ${b.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"}`}
        >
          {b.site === "ODDSJAM" ? "OddsJam" : "PropProf"} ↗
        </a>
        <div>
          <a
            className="ext"
            href={b.oddsScreenUrl.url}
            target="_blank"
            rel="noopener noreferrer"
            title={
              b.oddsScreenUrl.filteredTo === "sport"
                ? `${b.sport} odds — pick the market there, then search for the player`
                : "Odds screen — set the filters there, then search for the player"
            }
          >
            odds ↗
          </a>
        </div>
      </td>
      <td>
        <VerdictBadge beatClv={b.beatClv} status={b.status} />
      </td>
      <td>
        <ResultBadge gradeResult={b.gradeResult} gradeSource={b.gradeSource} />
      </td>
    </BetRow>
  );

  return (
    <>
      <div className="bets-toolbar">
        <button type="button" className={groupByDay ? "primary" : undefined} onClick={() => setGroupByDay((v) => !v)}>
          {groupByDay ? "Ungroup" : "Group by day"}
        </button>
      </div>

      {groups ? (
        groups.map(([key, rows]) => {
          const counts = dayCounts(rows);
          return (
            <div key={key} className="day-group">
              <h3 className="day-heading">
                {formatDayHeading(key)}
                <span className="muted day-heading-counts">
                  {" "}
                  · {rows.length} pick{rows.length === 1 ? "" : "s"} · {counts.waiting} awaiting close ·{" "}
                  {counts.settled} settled · {counts.graded} graded
                </span>
              </h3>
              <table>
                <thead>{head}</thead>
                <tbody>{rows.map(row)}</tbody>
              </table>
            </div>
          );
        })
      ) : (
        <table>
          <thead>{head}</thead>
          <tbody>{sorted.map(row)}</tbody>
        </table>
      )}
      {contextMenuElement}
    </>
  );
}
