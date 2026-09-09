import type { Status } from "@/lib/constants";

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    CLOSED: "neutral",
    PENDING: "neutral",
    DUE: "warn",
    NEEDS_GAME_TIME: "warn",
    UNAVAILABLE: "warn",
    FETCH_FAILED: "bad",
  };
  const label: Record<string, string> = {
    NEEDS_GAME_TIME: "NEEDS TIME",
    FETCH_FAILED: "FAILED",
  };
  return <span className={`badge ${tone[status] ?? "neutral"}`}>{label[status] ?? status}</span>;
}

export function VerdictBadge({ beatClv, status }: { beatClv: boolean | null; status: Status | string }) {
  if (status !== "CLOSED" || beatClv === null) return <StatusBadge status={status} />;
  return (
    <span className={`badge ${beatClv ? "good" : "bad"}`}>{beatClv ? "BEAT CLV" : "MISSED"}</span>
  );
}

export function fmtEdge(edge: number | null): string {
  if (edge === null) return "--";
  const sign = edge > 0 ? "+" : "";
  return `${sign}${edge.toFixed(2)}`;
}

export function fmtDateTime(value: Date | string | null): string {
  if (!value) return "--";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtPct(rate: number | null): string {
  return rate === null ? "--" : `${(rate * 100).toFixed(1)}%`;
}

/**
 * The pick's real outcome, kept visually distinct from the CLV verdict beside it. A hand-entered
 * grade is marked so it is never mistaken for one verified against a box score.
 */
export function ResultBadge({
  gradeResult,
  gradeSource,
}: {
  gradeResult: string | null;
  gradeSource?: string | null;
}) {
  if (!gradeResult) return <span className="muted">--</span>;
  const tone: Record<string, string> = {
    WIN: "good",
    LOSS: "bad",
    PUSH: "neutral",
    VOID: "neutral",
    UNGRADEABLE: "warn",
    GRADE_FAILED: "bad",
  };
  const label: Record<string, string> = {
    UNGRADEABLE: "NO SOURCE",
    GRADE_FAILED: "GRADE FAILED",
  };
  return (
    <span className={`badge ${tone[gradeResult] ?? "neutral"}`}>
      {label[gradeResult] ?? gradeResult}
      {gradeSource === "manual" && <span className="badge-sub"> manual</span>}
    </span>
  );
}
