import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getBetDetail, boardUrlFor, oddsScreenUrlFor } from "@/lib/queries";
import { CopyButton } from "@/components/copy-button";
import { BackLink } from "@/components/back-link";
import { ActionButton, type ActionResult } from "@/components/action-button";
import { ActionForm } from "@/components/action-form";
import { prisma } from "@/lib/prisma";
import { config, scheduledFetchAtFor, CLOSING_WINDOW_DESCRIPTION} from "@/lib/constants";
import { VerdictBadge, ResultBadge, fmtDateTime, fmtEdge, fmtOdds, betTitle, sideLabel } from "@/components/ui";
import { gradeBet, gradeManually } from "@/lib/grading/grader";
import { Signed } from "@/components/value";
import { Info } from "@/components/info";
import { MathBreakdown } from "@/components/math-breakdown";

export const dynamic = "force-dynamic";

interface LineRow {
  id: string;
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  logoUrl: string | null;
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
                  <span className="book">
                    {/* The board serves these, so the dashboard needs no icon set of its own. A
                        missing logo just leaves the name, which is why there is no placeholder. */}
                    {l.logoUrl && (
                      <img className="book-logo" src={l.logoUrl} alt="" width={16} height={16} loading="lazy" />
                    )}
                    <span>{l.label ?? l.bookKey}</span>
                    {!l.includedInAverage && (
                      <span className="muted" style={{ fontSize: 11 }}>
                        · not averaged
                      </span>
                    )}
                  </span>
                </td>
                <td className="num">{l.line ?? "--"}</td>
                <td className="num">{fmtOdds(l.price)}</td>
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
  async function queueClosingRead(): Promise<ActionResult> {
    "use server";
    await prisma.bet.update({
      where: { id },
      data: { scheduledFetchAt: new Date(), status: "PENDING", fetchAttempts: 0, lastFetchError: null },
    });
    revalidatePath(`/bets/${id}`);
    // The read itself happens in the browser extension, so the click cannot report a result --
    // saying who does the work next is the difference between "nothing happened" and "queued".
    return {
      message: "Queued for a closing read",
      detail:
        "A browser running the extension will pick this up on its next poll, within a minute. Chrome must be open and signed in to the board.",
    };
  }

  async function setGameTime(formData: FormData): Promise<ActionResult> {
    "use server";
    const raw = String(formData.get("gameStartTime") ?? "");
    const start = new Date(raw);
    if (Number.isNaN(start.getTime())) {
      return { ok: false, message: "Enter a valid kickoff time" };
    }
    await prisma.bet.update({
      where: { id },
      data: {
        gameStartTime: start,
        scheduledFetchAt: scheduledFetchAtFor(start),
        gradeScheduledAt: new Date(start.getTime() + config.gradeDelayHours * 3600_000),
        status: "PENDING",
        fetchAttempts: 0,
        lastFetchError: null,
      },
    });
    revalidatePath(`/bets/${id}`);
    return { message: "Kickoff set and closing read scheduled" };
  }

  async function gradeNow(): Promise<ActionResult> {
    "use server";
    await prisma.bet.update({
      where: { id },
      data: { gradeAttempts: 0, gradeReason: null, gradeScheduledAt: new Date() },
    });
    const { result, reason } = await gradeBet(id);
    revalidatePath(`/bets/${id}`);
    // Report what the grader actually concluded. "RETRY" and "UNGRADEABLE" are not successes, and
    // silently re-rendering the page made them indistinguishable from a graded pick.
    if (result === "MISSING") return { ok: false, message: "This pick no longer exists" };
    if (result === "RETRY") {
      return { ok: false, message: "Could not grade it yet", detail: reason ?? "Will retry automatically." };
    }
    if (result === "GRADE_FAILED" || result === "UNGRADEABLE") {
      return { ok: false, message: `Not graded — ${result === "UNGRADEABLE" ? "no source" : "grading failed"}`, detail: reason ?? null };
    }
    return { message: `Graded: ${result}`, detail: reason ?? null };
  }

  async function submitManualGrade(formData: FormData): Promise<ActionResult> {
    "use server";
    const raw = String(formData.get("actualValue") ?? "").trim();
    if (raw === "") return { ok: false, message: "Enter the actual result first" };
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, message: `"${raw}" is not a number` };
    }
    // The outcome is always derived from the value typed in, so the stored number and the stored
    // result can never contradict each other.
    await gradeManually(id, value);
    revalidatePath(`/bets/${id}`);
    return { message: `Recorded ${value}` };
  }

  async function voidBet(): Promise<ActionResult> {
    "use server";
    await prisma.bet.update({
      where: { id },
      data: {
        gradeResult: "VOID",
        actualValue: null,
        gradedAt: new Date(),
        gradeSource: "manual",
        gradeReason: "Voided by hand",
      },
    });
    revalidatePath(`/bets/${id}`);
    return { message: "Marked void" };
  }

  async function clearGrade(): Promise<ActionResult> {
    "use server";
    await prisma.bet.update({
      where: { id },
      data: {
        gradeResult: null,
        actualValue: null,
        gradedAt: null,
        gradeSource: null,
        gradeReason: null,
        gradeAttempts: 0,
        gradeScheduledAt: new Date(),
      },
    });
    revalidatePath(`/bets/${id}`);
    return { message: "Grade cleared and re-queued" };
  }

  async function deleteBet(): Promise<ActionResult> {
    "use server";
    await prisma.bet.delete({ where: { id } });
    revalidatePath("/bets");
    // Throws NEXT_REDIRECT; ActionButton recognises that as navigation rather than a failure.
    redirect("/bets");
  }

  const lagMinutes =
    bet.closingCaptureLagSeconds !== null ? Math.round(bet.closingCaptureLagSeconds / 60) : null;
  const lateBy = lagMinutes !== null && lagMinutes > config.staleCaptureMinutes ? lagMinutes : null;
  // A negative lag is the *good* case now that reads happen before kickoff, so it is only worth
  // mentioning when the read landed before the window should even have opened -- which means the
  // number predates the last of the pre-kickoff steam.
  const earlyBy =
    lagMinutes !== null && -lagMinutes > config.closingReadOpensMinutesBefore ? -lagMinutes : null;

  const provenance = bet.gradeRawJson
    ? (JSON.parse(bet.gradeRawJson) as { webUrl?: string | null })
    : null;

  /**
   * How far the result landed from what the bet needed.
   *
   * A spread is measured against the NEGATED handicap -- taking +5.5 needs a margin better than
   * -5.5 -- so subtracting the raw line (as a prop does) would report a nonsense number. A
   * moneyline is the same margin with no handicap to beat -- it needs better than 0 -- so the
   * margin is the actual value itself; `takenLine` there holds the average price, not a margin,
   * and subtracting it would be just as wrong.
   */
  const resultMargin =
    bet.actualValue === null
      ? null
      : bet.marketType === "SPREAD"
        ? bet.actualValue + bet.takenLine
        : bet.marketType === "MONEYLINE"
          ? bet.actualValue
          : bet.actualValue - bet.takenLine;

  const resultSentence =
    bet.actualValue === null ? null : bet.marketType === "SPREAD" ? (
      <>
        {bet.subjectTeam ?? "The team"} finished{" "}
        <strong>
          {bet.actualValue > 0 ? `+${bet.actualValue}` : bet.actualValue}
        </strong>{" "}
        on the scoreboard against a {bet.takenLine > 0 ? `+${bet.takenLine}` : bet.takenLine}{" "}
        spread — {(resultMargin ?? 0) > 0 ? "covered by" : (resultMargin ?? 0) === 0 ? "landed exactly on" : "short by"}{" "}
        {Math.abs(resultMargin ?? 0)}.
      </>
    ) : bet.marketType === "MONEYLINE" ? (
      <>
        {bet.subjectTeam ?? "The team"} finished the game{" "}
        <strong>
          {bet.actualValue > 0 ? `up ${bet.actualValue}` : bet.actualValue < 0 ? `down ${Math.abs(bet.actualValue)}` : "level"}
        </strong>{" "}
        on the scoreboard —{" "}
        {bet.actualValue > 0 ? "won outright." : bet.actualValue < 0 ? "lost outright." : "the game ended level."}
      </>
    ) : bet.marketType === "GAME_TOTAL" ? (
      <>
        The game totalled <strong>{bet.actualValue}</strong> — you needed{" "}
        {sideLabel(bet.side).toLowerCase()} {bet.takenLine}.
      </>
    ) : (
      <>
        {bet.player ?? "This market"} recorded <strong>{bet.actualValue}</strong> — you needed{" "}
        {sideLabel(bet.side).toLowerCase()} {bet.takenLine}.
      </>
    );

  // A moneyline's "line" is itself an American-odds price -- +130, not 130 -- so it is worded
  // with the same explicit sign every other price in the app carries.
  const movement =
    bet.avgClosingLine !== null
      ? `Line moved from ${bet.marketType === "MONEYLINE" ? fmtOdds(bet.takenLine) : bet.takenLine} ` +
        `to ${bet.marketType === "MONEYLINE" ? fmtOdds(Math.round(bet.avgClosingLine)) : bet.avgClosingLine.toFixed(2)} ` +
        `(average of ${bet.closingBookCount} book${bet.closingBookCount === 1 ? "" : "s"}) — ` +
        `${fmtEdge(bet.edge)} ${bet.beatClv ? "in your favour" : "against you"}.`
      : null;

  return (
    <main>
      <div style={{ marginBottom: 16 }}>
        <BackLink fallbackHref="/bets" label="← Back" />
      </div>

      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>
        {betTitle(bet)}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {bet.statMarket} · {bet.matchup ?? "—"} · {bet.sport ?? "—"} ·{" "}
        {bet.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"} / {bet.fantasyBook} · kickoff{" "}
        {fmtDateTime(bet.gameStartTime)} ·{" "}
        <a href={boardUrlFor(bet)} target="_blank" rel="noopener noreferrer">
          open board on {bet.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"} ↗
        </a>{" "}
        ·{" "}
        <a href={oddsScreenUrlFor(bet).url} target="_blank" rel="noopener noreferrer">
          current odds ↗
        </a>
      </p>
      <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>
        {oddsScreenUrlFor(bet).filteredTo === "sport" ? (
          <>
            That link lands on the {bet.sport} odds page — neither site lets a market or a player be
            set from a URL, so choose {bet.statMarket} there and search for the player.
          </>
        ) : (
          <>
            PropProfessor keeps its screen filters in memory rather than the URL, so they cannot be
            pre-filled from a link — set them there and search for the player.
          </>
        )}{" "}
        {bet.player && <CopyButton value={bet.player} label="Copy player name" />}
      </p>

      <div className="verdict">
        <div className="headline">
          <ResultBadge gradeResult={bet.gradeResult} gradeSource={bet.gradeSource} />{" "}
          {bet.actualValue !== null && <Signed value={resultMargin} />}
        </div>
        <div className="detail">
          {bet.actualValue !== null ? (
            resultSentence
          ) : bet.gradeResult === "VOID" ? (
            "No result: the player did not play, or the game did not finish."
          ) : bet.gradeResult === "UNGRADEABLE" || bet.gradeResult === "GRADE_FAILED" ? (
            "Not settled automatically — enter the actual result below to count it."
          ) : (
            `Waiting for the box score. Grading runs ${config.gradeDelayHours}h after kickoff.`
          )}
        </div>
        {bet.gradeReason && <p className="err">{bet.gradeReason}</p>}
        {provenance?.webUrl && (
          <p className="muted" style={{ fontSize: 12 }}>
            Graded from the {bet.gradeSource === "mlb" ? "MLB" : "ESPN"} box score{" "}
            {fmtDateTime(bet.gradedAt)} ·{" "}
            <a href={provenance.webUrl} target="_blank" rel="noopener noreferrer">
              check it ↗
            </a>
          </p>
        )}

        {/* Sibling forms, never nested: ActionForm renders its own <form>, and nesting forms is
            invalid HTML that browsers silently unnest. */}
        <div className="grade-actions">
          <ActionForm
            action={submitManualGrade}
            submitLabel={bet.actualValue === null ? "Save result" : "Correct result"}
            className="inline"
          >
            <input
              type="number"
              step="any"
              name="actualValue"
              placeholder="actual result"
              defaultValue={bet.actualValue ?? ""}
            />
          </ActionForm>

          {bet.gradeResult !== "UNGRADEABLE" && (
            <ActionButton
              action={gradeNow}
              label="Grade now"
              pendingLabel="Grading..."
              disabledReason={
                bet.gameStartTime === null
                  ? "This pick has no kickoff time, so there is no game to look up yet."
                  : bet.gameStartTime > new Date()
                    ? `The game has not started yet — it kicks off ${fmtDateTime(bet.gameStartTime)}.`
                    : null
              }
            />
          )}
          <ActionButton
            action={voidBet}
            label="Void"
            success="Marked void"
            confirmTitle="Mark this pick void?"
            confirm={["A void pick keeps its CLV verdict but records no win or loss."]}
            confirmLabel="Mark void"
            disabledReason={
              bet.gradeResult === "VOID" ? "This pick is already marked void." : null
            }
          />
          {bet.gradeResult && (
            <ActionButton
              action={clearGrade}
              label="Clear grade"
              confirmTitle="Clear the recorded result?"
              confirm={["The pick goes back in the grading queue and will be re-graded."]}
              confirmLabel="Clear grade"
            />
          )}
        </div>
      </div>

      <div className="verdict">
        <div className="headline">
          {bet.openEvPercent === null ? (
            <span className="muted">EV not recorded</span>
          ) : (
            <>
              <Signed value={bet.openEvPercent} unit="%" /> EV
            </>
          )}
          <Info title="Expected value when you took it" anchor="ev">
            The board&apos;s own edge on this pick at the moment you ticked it, from its no-vig
            probability at your exact line.
          </Info>
        </div>
        <div className="detail">
          {bet.openFairProb !== null ? (
            <>
              {bet.site === "ODDSJAM" ? "OddsJam" : "PropProfessor"} put the chance to hit at{" "}
              <strong>{(bet.openFairProb * 100).toFixed(1)}%</strong> when you took it.
              {bet.closeFairProb !== null && (
                <>
                  {" "}By close it was <strong>{(bet.closeFairProb * 100).toFixed(1)}%</strong> (
                  <Signed value={bet.closeEvPercent} unit="%" /> EV).
                </>
              )}
            </>
          ) : bet.openEvPercent !== null ? (
            <>
              This board states an EV% directly rather than a chance to hit, so it is recorded as
              shown.
            </>
          ) : (
            "This pick was captured before EV% was recorded, so it carries none."
          )}
        </div>
      </div>

      <div className="verdict">
        <div className="headline">
          <VerdictBadge beatClv={bet.beatClv} status={bet.status} />{" "}
          {bet.status === "CLOSED" ? <Signed value={bet.edge} /> : ""}
          <Info title="CLV edge" anchor="clv">
            Over: average closing line minus the line you took. Under: the reverse. Positive means
            the market moved toward you before kickoff.
          </Info>
          {bet.priceEdge !== null && (
            <span style={{ marginLeft: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                price{" "}
              </span>
              <Signed value={bet.priceEdge} unit="pp" />
              <Info title="Price-based CLV" anchor="price-clv">
                The same question asked of the price instead of the number: the market&apos;s
                de-vigged chance that this pick hits at close, minus its chance when you took it, in
                probability points. It exists because the line-based edge beside it reads exactly 0
                on a market that never moved its number — a total parked at 47.5 all week while the
                price drifts from −110 to −130 has moved hard against one side, and only this sees
                it. Neither replaces the other: on a player prop the number is what moves, and the
                line edge is the better measure of it.
              </Info>
            </span>
          )}
        </div>
        <div className="detail">
          {movement ??
            (bet.status === "LIVE_NO_CLV"
              ? "Taken in-play, so there is no closing line to measure against — the line was already mid-game. EV% is still recorded and the pick is graded normally."
              : bet.status === "UNAVAILABLE"
              ? "The market was still listed at close, but this selection was not in it — usually a scratch or a pulled prop."
              : bet.status === "NO_CLOSING_MARKET"
              ? "No sportsbook prices this market, so a closing line cannot exist for it. Nothing went wrong, and this pick is left out of CLV rates rather than counted against them."
              : bet.status === "NEEDS_GAME_TIME"
                ? "Captured without a kickoff time, so the closing fetch could not be scheduled. Set one below."
                : bet.status === "FETCH_FAILED"
                  ? "The closing fetch did not complete."
                  : `Waiting for kickoff. The closing lines are read ${CLOSING_WINDOW_DESCRIPTION}, by the extension in your browser.`)}
        </div>
        {lateBy !== null && (
          <p className="err">
            Read {lateBy} min after kickoff — Chrome was probably not running at the time, so these
            are post-game lines rather than closing lines.
          </p>
        )}
        {earlyBy !== null && (
          <p className="muted">
            Read {earlyBy} min before kickoff, earlier than the usual window — this may not reflect
            late line movement.
          </p>
        )}
        {bet.lastFetchError && <p className="err">{bet.lastFetchError}</p>}

        {bet.status === "NEEDS_GAME_TIME" && (
          <ActionForm
            action={setGameTime}
            submitLabel="Set kickoff & schedule"
            className="inline"
          >
            <input type="datetime-local" name="gameStartTime" required />
          </ActionForm>
        )}

        <div className="inline">
          <ActionButton
            action={queueClosingRead}
            label={bet.status === "CLOSED" ? "Queue another closing read" : "Queue closing read now"}
            pendingLabel="Queueing..."
            disabledReason={
              bet.isLive
                ? "This pick was taken in-play, so there is no closing line to read — the line was already mid-game."
                : bet.status === "NEEDS_GAME_TIME"
                  ? "Set a kickoff time first — without one there is nothing to schedule against."
                  : bet.status === "DUE"
                    ? "Already queued and waiting for a browser with the extension to pick it up."
                    : null
            }
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {bet.status === "DUE"
              ? "Queued — waiting for a browser with the extension to pick it up"
              : bet.fetchAttempts > 0
                ? `${bet.fetchAttempts} attempt(s), last ${fmtDateTime(bet.lastFetchAt)}`
                : ""}
          </span>
        </div>
      </div>

      <div className="danger-zone">
        <ActionButton
          action={deleteBet}
          label="Delete this pick"
          danger
          confirmTitle="Delete this pick?"
          confirm={[
            `${bet.player} ${bet.side} ${bet.takenLine} and both of its snapshots will be removed. This cannot be undone.`,
          ]}
          confirmLabel="Delete permanently"
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

      <MathBreakdown bet={bet} />
    </main>
  );
}
