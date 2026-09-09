import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getBetDetail, boardUrlFor } from "@/lib/queries";
import { ConfirmButton } from "@/components/confirm-button";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/constants";
import { StatusBadge, VerdictBadge, fmtDateTime, fmtEdge } from "@/components/ui";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";

export const dynamic = "force-dynamic";

interface LineRow {
  id: string;
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  includedInAverage: boolean;
}

/**
 * Same component for both sides of the comparison so the open and close tables line up visually
 * and the movement is readable at a glance.
 */
function SnapshotTable({
  title,
  when,
  lines,
  emptyNote,
}: {
  title: string;
  when: string;
  lines: LineRow[];
  emptyNote: string;
}) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="when">{when}</div>
      {lines.length === 0 ? (
        <p className="muted">{emptyNote}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Book</th>
              <th className="num">Line</th>
              <th className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={l.includedInAverage ? "" : "excluded"}>
                <td>
                  {l.label ?? l.bookKey}
                  {!l.includedInAverage && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" "}
                      · not averaged
                    </span>
                  )}
                </td>
                <td className="num">{l.line ?? "--"}</td>
                <td className="num">{l.price ?? "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function BetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bet = await getBetDetail(id);
  if (!bet) notFound();

  // The closing board can only be read by the extension in your own logged-in browser, so this
  // makes the pick due now and the extension collects it on its next poll (within a minute or so).
  async function queueClosingRead() {
    "use server";
    await prisma.bet.update({
      where: { id },
      data: { scheduledFetchAt: new Date(), status: "PENDING", fetchAttempts: 0, lastFetchError: null },
    });
    revalidatePath(`/bets/${id}`);
  }

  async function setGameTime(formData: FormData) {
    "use server";
    const raw = String(formData.get("gameStartTime") ?? "");
    const start = new Date(raw);
    if (Number.isNaN(start.getTime())) return;
    await prisma.bet.update({
      where: { id },
      data: {
        gameStartTime: start,
        scheduledFetchAt: new Date(start.getTime() + config.closingBufferMinutes * 60_000),
        status: "PENDING",
        fetchAttempts: 0,
        lastFetchError: null,
      },
    });
    revalidatePath(`/bets/${id}`);
  }

  async function deleteBet() {
    "use server";
    await prisma.bet.delete({ where: { id } });
    revalidatePath("/bets");
    redirect("/bets");
  }

  const lagMinutes =
    bet.closingCaptureLagSeconds !== null ? Math.round(bet.closingCaptureLagSeconds / 60) : null;
  const lateBy = lagMinutes !== null && lagMinutes > config.staleCaptureMinutes ? lagMinutes : null;

  const movement =
    bet.avgClosingLine !== null
      ? `Line moved from ${bet.takenLine} to ${bet.avgClosingLine.toFixed(2)} ` +
        `(average of ${bet.closingBookCount} book${bet.closingBookCount === 1 ? "" : "s"}) — ` +
        `${fmtEdge(bet.edge)} ${bet.beatClv ? "in your favour" : "against you"}.`
      : null;

  return (
    <main>
      <div style={{ marginBottom: 16 }}>
        <a href="/bets" className="muted">
          ← All picks
        </a>
      </div>

      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>
        {bet.player} {bet.side} {bet.takenLine}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {bet.statMarket} · {bet.matchup ?? "—"} · {bet.sport ?? "—"} ·{" "}
        {bet.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"} / {bet.fantasyBook} · kickoff{" "}
        {fmtDateTime(bet.gameStartTime)} ·{" "}
        <a href={boardUrlFor(bet)} target="_blank" rel="noopener noreferrer">
          open board on {bet.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"} ↗
        </a>
      </p>

      <div className="verdict">
        <div className="headline">
          <VerdictBadge beatClv={bet.beatClv} status={bet.status} />{" "}
          {bet.status === "CLOSED" ? <Signed value={bet.edge} /> : ""}
          <Info title="CLV edge" anchor="clv">
            Over: average closing line minus the line you took. Under: the reverse. Positive means
            the market moved toward you before kickoff.
          </Info>
        </div>
        <div className="detail">
          {movement ??
            (bet.status === "UNAVAILABLE"
              ? "No sportsbook was still quoting this prop when the market closed, so there is no closing line to compare against."
              : bet.status === "NEEDS_GAME_TIME"
                ? "Captured without a kickoff time, so the closing fetch could not be scheduled. Set one below."
                : bet.status === "FETCH_FAILED"
                  ? "The closing fetch did not complete."
                  : `Waiting for kickoff. The closing board is read ${config.closingBufferMinutes} minutes after the game starts, by the extension in your browser.`)}
        </div>
        {lateBy !== null && (
          <p className="err">
            Read {lateBy} min after kickoff — Chrome was probably not running at the time, so these
            are post-game lines rather than closing lines.
          </p>
        )}
        {bet.lastFetchError && <p className="err">{bet.lastFetchError}</p>}

        {bet.status === "NEEDS_GAME_TIME" && (
          <form action={setGameTime} className="inline">
            <input type="datetime-local" name="gameStartTime" required />
            <button type="submit">Set kickoff &amp; schedule</button>
          </form>
        )}

        <form action={queueClosingRead} className="inline">
          <button type="submit">
            {bet.status === "CLOSED" ? "Queue another closing read" : "Queue closing read now"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {bet.status === "DUE"
              ? "Queued — waiting for a browser with the extension to pick it up"
              : bet.fetchAttempts > 0
                ? `${bet.fetchAttempts} attempt(s), last ${fmtDateTime(bet.lastFetchAt)}`
                : ""}
          </span>
        </form>
      </div>

      <div className="danger-zone">
        <ConfirmButton
          action={deleteBet}
          label="Delete this pick"
          danger
          confirm={[`Delete ${bet.player} ${bet.side} ${bet.takenLine}? This cannot be undone.`]}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Removes this pick and both its snapshots from the database.
        </span>
      </div>

      <div className="split">
        <SnapshotTable
          title="When you took it"
          when={fmtDateTime(bet.openCapturedAt)}
          lines={bet.openLines}
          emptyNote="No book columns were rendered in this row."
        />
        <SnapshotTable
          title="At market close"
          when={bet.closeCapturedAt ? fmtDateTime(bet.closeCapturedAt) : "not captured yet"}
          lines={bet.closeLines}
          emptyNote="Closing lines have not been captured yet."
        />
      </div>
    </main>
  );
}
