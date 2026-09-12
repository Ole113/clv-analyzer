"use client";

import { useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { listBets } from "@/lib/queries";
import { VerdictBadge, ResultBadge, fmtDateTime, fmtOdds, sideLabel, betTitle } from "@/components/ui";
import { BetRow } from "@/components/bet-row";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";
import { useBetContextMenu } from "@/components/bet-context-menu";
import { OddsPreviewButton } from "@/components/odds-preview-modal";

type Bet = Awaited<ReturnType<typeof listBets>>[number] & {
  boardUrl: string;
  oddsScreenUrl: { url: string; filteredTo: string };
};

type SortKey =
  | "pick"
  | "market"
  | "side"
  | "taken"
  | "avgClose"
  | "edge"
  | "ev"
  | "actual"
  | "kickoff"
  | "board"
  | "clv"
  | "result";
const SORT_KEYS = new Set<SortKey>([
  "pick", "market", "side", "taken", "avgClose", "edge", "ev", "actual", "kickoff", "board", "clv", "result",
]);
type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

/** Every column's own comparable value -- a lowercased string for text columns, a plain number for
 *  everything else, so one comparator (below) can sort either without column-specific branching. */
function sortValue(b: Bet, key: SortKey): string | number | null {
  switch (key) {
    case "pick":
      return (b.player ?? b.selectionName ?? b.statMarket ?? "").toLowerCase();
    case "market":
      return (b.statMarket ?? "").toLowerCase();
    case "side":
      return (sideLabel(b.side) ?? "").toLowerCase();
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
    case "kickoff":
      return b.gameStartTime ? b.gameStartTime.getTime() : null;
    case "board":
      return b.site === "ODDSJAM" ? "oddsjam" : "propprofessor";
    case "clv":
      return b.beatClv === null ? null : b.beatClv ? 1 : 0;
    case "result":
      return (b.gradeResult ?? "").toLowerCase();
  }
}

/** Nulls (and empty strings) sort last regardless of direction -- "no value yet" is not
 *  meaningfully high or low. */
function compareBets(a: Bet, b: Bet, sort: Sort): number {
  if (!sort) return 0;
  const av = sortValue(a, sort.key);
  const bv = sortValue(b, sort.key);
  const aEmpty = av === null || av === "";
  const bEmpty = bv === null || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
  return sort.dir === "asc" ? cmp : -cmp;
}

function SortIndicator({ dir }: { dir: "asc" | "desc" }) {
  return <span className="sort-indicator">{dir === "asc" ? " ▲" : " ▼"}</span>;
}

function SortableTh({
  sortKey,
  sort,
  onSort,
  numeric = true,
  children,
}: {
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  /** Text columns (Pick, Market, ...) keep their natural left alignment; only the numeric ones
   *  right-align, matching every other header in this table. */
  numeric?: boolean;
  children: React.ReactNode;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      className={numeric ? "num sortable" : "sortable"}
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

const WAITING_STATUSES = new Set(["PENDING", "DUE", "NEEDS_GAME_TIME"]);

function statusCounts(rows: Bet[]): { waiting: number; settled: number; graded: number } {
  let waiting = 0;
  let settled = 0;
  let graded = 0;
  for (const b of rows) {
    if (b.status === "CLOSED") settled++;
    if (WAITING_STATUSES.has(b.status)) waiting++;
    if (b.gradeResult === "WIN" || b.gradeResult === "LOSS") graded++;
  }
  return { waiting, settled, graded };
}

export function BetsTable({ bets }: { bets: Bet[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { openContextMenu, contextMenuElement } = useBetContextMenu();

  /**
   * Sort and group live in the URL, not local state, for one reason: it is what makes them survive
   * a real navigation. Following "odds ↗" -- no, following a pick to `/bets/[id]` and pressing
   * Back returns to this exact URL; if sort/group were `useState` here, a fresh `BetsTable`
   * instance would mount on that return trip with nothing remembered. The filter bar already works
   * this way (see filter-bar.tsx's `submit`), so this keeps the whole page's state in one place.
   */
  const sort: Sort = useMemo(() => {
    const key = searchParams.get("sort");
    const dir = searchParams.get("dir");
    if (!key || !SORT_KEYS.has(key as SortKey) || (dir !== "asc" && dir !== "desc")) return null;
    return { key: key as SortKey, dir };
  }, [searchParams]);
  const groupByDay = searchParams.get("group") === "day";
  const q = searchParams.get("q");

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const onSort = (key: SortKey) => {
    updateParams((params) => {
      if (params.get("sort") !== key) {
        params.set("sort", key);
        params.set("dir", "asc");
      } else if (params.get("dir") === "asc") {
        params.set("dir", "desc");
      } else {
        params.delete("sort");
        params.delete("dir");
      }
    });
  };

  const toggleGroup = () => {
    updateParams((params) => {
      if (params.get("group") === "day") params.delete("group");
      else params.set("group", "day");
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

  const overall = statusCounts(bets);

  const head = (
    <tr>
      <SortableTh sortKey="pick" sort={sort} onSort={onSort} numeric={false}>
        Pick
      </SortableTh>
      <SortableTh sortKey="market" sort={sort} onSort={onSort} numeric={false}>
        Market
      </SortableTh>
      <SortableTh sortKey="side" sort={sort} onSort={onSort} numeric={false}>
        Side
      </SortableTh>
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
      <SortableTh sortKey="kickoff" sort={sort} onSort={onSort} numeric={false}>
        Kickoff
      </SortableTh>
      <SortableTh sortKey="board" sort={sort} onSort={onSort} numeric={false}>
        Board
      </SortableTh>
      <SortableTh sortKey="clv" sort={sort} onSort={onSort} numeric={false}>
        CLV
      </SortableTh>
      <SortableTh sortKey="result" sort={sort} onSort={onSort} numeric={false}>
        Result
      </SortableTh>
    </tr>
  );

  const row = (b: Bet) => (
    <BetRow key={b.id} onContextMenu={(e) => openContextMenu(e, b.id, betTitle(b))}>
      <td>
        {/* The only thing on the row that navigates to the pick. */}
        <a className="pick-link" href={`/bets/${b.id}`}>
          {b.player ?? b.selectionName ?? b.statMarket}
        </a>
        {b.isLive && <span className="live-chip">LIVE</span>}
        <div className="muted" style={{ fontSize: 12 }}>{b.matchup ?? b.sport ?? ""}</div>
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
          <OddsPreviewButton
            betId={b.id}
            label={`${b.player ?? b.subjectTeam ?? b.statMarket} ${sideLabel(b.side) ?? ""} ${b.takenLine ?? ""}`.trim()}
            fallbackUrl={b.oddsScreenUrl.url}
            fallbackNote={
              b.oddsScreenUrl.filteredTo === "sport"
                ? `If that doesn't turn up anything: lands on the ${b.sport} odds page — search for the player there.`
                : "If that doesn't turn up anything: set PropProfessor's screen filters there and search for the player."
            }
            triggerLabel="odds ↗"
            triggerClassName="ext link-button"
          />
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
        <p className="result-count">
          {bets.length} pick{bets.length === 1 ? "" : "s"}
          {q ? ` matching “${q}”` : ""} · {overall.waiting} awaiting close · {overall.settled} settled ·{" "}
          {overall.graded} graded
        </p>
        <button type="button" className={groupByDay ? "primary" : undefined} onClick={toggleGroup}>
          {groupByDay ? "Ungroup" : "Group by day"}
        </button>
      </div>

      {groups ? (
        groups.map(([key, rows]) => {
          const counts = statusCounts(rows);
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
