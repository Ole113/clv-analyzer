import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { config, CLOSING_WINDOW_DESCRIPTION} from "@/lib/constants";
import { DEFAULT_PICKEM_PRICE } from "@/lib/ev";
import { PurgeForm } from "@/components/purge-form";
import { TestDataForm } from "@/components/test-data-form";
import { BookSettingsForm } from "@/components/book-settings-form";
import { ActionButton, type ActionResult } from "@/components/action-button";
import { runDueGrades } from "@/lib/grading/grader";
import { BREAK_EVEN_RATE } from "@/lib/ev";
import { generateTestData, TEST_DATA_SOURCE_DEVICES, MAX_TEST_DATA_PER_REQUEST } from "@/lib/test-data";
import { getAppSettings, knownBooks, saveBookOrder, saveBookWeights } from "@/lib/app-settings";
import { getRecentIngestFailures, countIngestFailures, clearIngestFailures } from "@/lib/ingest-log";

const SECTIONS = [
  { id: "database", label: "Database" },
  { id: "books", label: "Books" },
  { id: "grading", label: "Grading" },
  { id: "closing-config", label: "Closing read config" },
  { id: "ingest-failures", label: "Ingest failures" },
];

export const dynamic = "force-dynamic";

const UNIT_HOURS: Record<string, number> = {
  days: 24,
  weeks: 24 * 7,
  months: 24 * 30,
  years: 24 * 365,
};

export default async function SettingsPage() {
  const [total, oldest, newest, demo, books, bookSettings] = await Promise.all([
    prisma.bet.count(),
    prisma.bet.findFirst({ orderBy: { openCapturedAt: "asc" }, select: { openCapturedAt: true } }),
    prisma.bet.findFirst({ orderBy: { openCapturedAt: "desc" }, select: { openCapturedAt: true } }),
    prisma.bet.count({ where: { sourceDevice: { in: TEST_DATA_SOURCE_DEVICES } } }),
    knownBooks(),
    getAppSettings(),
  ]);
  // Every known book, ordered by the saved preference, with anything not yet ordered tacked on
  // the end -- so a newly-seen book still gets a row instead of vanishing from the list.
  const orderedBookKeys = [
    ...bookSettings.bookOrder.filter((k) => books.some((b) => b.bookKey === k)),
    ...books.map((b) => b.bookKey).filter((k) => !bookSettings.bookOrder.includes(k)),
  ];

  async function saveBookSettingsAction(
    order: string[],
    weights: Record<string, number>,
    useWeightedAverage: boolean,
    useLiquidityWeighting: boolean
  ): Promise<void> {
    "use server";
    await Promise.all([
      saveBookOrder(order),
      saveBookWeights(weights, useWeightedAverage, useLiquidityWeighting),
    ]);
    revalidatePath("/settings");
    revalidatePath("/bets");
  }

  /** Counts what a purge would remove, so the confirmation can name a real number. */
  async function countPurge(amount: number, unit: string, onlyTestData: boolean): Promise<number> {
    "use server";
    const hours = (UNIT_HOURS[unit] ?? 24) * amount;
    const cutoff = new Date(Date.now() - hours * 3600_000);
    return prisma.bet.count({
      where: {
        openCapturedAt: { gte: cutoff },
        ...(onlyTestData ? { sourceDevice: { in: TEST_DATA_SOURCE_DEVICES } } : {}),
      },
    });
  }

  /** Deletes picks captured within the last N days/weeks/months/years. Snapshots cascade. */
  async function purgeRecent(amount: number, unit: string, onlyTestData: boolean): Promise<number> {
    "use server";
    const hours = (UNIT_HOURS[unit] ?? 24) * amount;
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const { count } = await prisma.bet.deleteMany({
      where: {
        openCapturedAt: { gte: cutoff },
        ...(onlyTestData ? { sourceDevice: { in: TEST_DATA_SOURCE_DEVICES } } : {}),
      },
    });
    revalidatePath("/settings");
    revalidatePath("/bets");
    revalidatePath("/analysis");
    revalidatePath("/");
    return count;
  }

  async function purgeDemo(): Promise<number> {
    "use server";
    const { count } = await prisma.bet.deleteMany({
      where: { sourceDevice: { in: TEST_DATA_SOURCE_DEVICES } },
    });
    revalidatePath("/settings");
    revalidatePath("/bets");
    revalidatePath("/analysis");
    revalidatePath("/");
    return count;
  }

  /** Loads N fake picks tagged as test data, so the UI can be tried out without real captures. */
  async function generateTestDataAction(amount: number): Promise<number> {
    "use server";
    const n = await generateTestData(amount);
    revalidatePath("/settings");
    revalidatePath("/bets");
    revalidatePath("/analysis");
    revalidatePath("/");
    return n;
  }

  async function runGrader(): Promise<ActionResult> {
    "use server";
    const n = await runDueGrades();
    revalidatePath("/settings");
    revalidatePath("/bets");
    revalidatePath("/analysis");
    // "Nothing was due" is the common outcome and used to look identical to a no-op click.
    return n === 0
      ? { message: "Nothing was due", detail: "No pick has reached its grading time yet." }
      : { message: `Graded ${n} pick${n === 1 ? "" : "s"}` };
  }

  async function clearIngestFailuresAction(): Promise<ActionResult> {
    "use server";
    const n = await clearIngestFailures();
    revalidatePath("/settings");
    return { message: `Cleared ${n} log entr${n === 1 ? "y" : "ies"}` };
  }

  const gradeCounts = await prisma.bet.groupBy({ by: ["gradeResult"], _count: true });
  const countOf = (result: string | null) =>
    gradeCounts.find((g) => g.gradeResult === result)?._count ?? 0;

  const [ingestFailures, ingestFailureTotal] = await Promise.all([
    getRecentIngestFailures(25),
    countIngestFailures(),
  ]);

  const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString() : "--");

  const STAGE_LABEL: Record<string, string> = {
    validation: "Malformed payload",
    shape: "Impossible combination",
    exception: "Server error",
  };

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="settings-content">

      <section className="chart-card" id="database">
        <h3>Database</h3>
        <p className="lede">
          {total} pick{total === 1 ? "" : "s"} stored
          {total > 0 && (
            <>
              , captured between {fmt(oldest?.openCapturedAt)} and {fmt(newest?.openCapturedAt)}
            </>
          )}
          {demo > 0 && <> · {demo} are test data</>}
        </p>

        <PurgeForm countAction={countPurge} purgeAction={purgeRecent} />

        <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <TestDataForm max={MAX_TEST_DATA_PER_REQUEST} generateAction={generateTestDataAction} />
        </div>

        {demo > 0 && (
          <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <PurgeForm demoOnly demoCount={demo} purgeDemoAction={purgeDemo} />
          </div>
        )}
      </section>

      <section className="chart-card" id="books">
        <h3>Books</h3>
        <p className="lede">
          Controls the book order shown in the &quot;When you took it&quot; / &quot;At market
          close&quot; tables on a pick, and optionally how much each book counts toward the
          closing average used for CLV.
        </p>
        <BookSettingsForm
          initialOrder={orderedBookKeys}
          books={books}
          initialWeights={bookSettings.bookWeights}
          initialUseWeighted={bookSettings.useWeightedAverage}
          initialUseLiquidity={bookSettings.useLiquidityWeighting}
          saveAction={saveBookSettingsAction}
        />
      </section>

      <section className="chart-card" id="grading">
        <h3>Grading</h3>
        <p className="lede">
          Results are read from public box scores by the server itself, so grading keeps working
          with Chrome closed.
        </p>
        <table>
          <tbody>
            <tr><td>Won / lost</td><td className="num">{countOf("WIN")} / {countOf("LOSS")}</td></tr>
            <tr><td>Pushes / voids</td><td className="num">{countOf("PUSH")} / {countOf("VOID")}</td></tr>
            <tr><td>No source (hand-gradeable)</td><td className="num">{countOf("UNGRADEABLE")}</td></tr>
            <tr><td>Grade failed</td><td className="num">{countOf("GRADE_FAILED")}</td></tr>
            <tr><td>Awaiting grade</td><td className="num">{countOf(null)}</td></tr>
            <tr><td>First attempt after kickoff</td><td className="num">{config.gradeDelayHours}h</td></tr>
            <tr><td>Checks for due picks every</td><td className="num">{config.gradePollMinutes} min</td></tr>
            <tr><td>Attempts before giving up</td><td className="num">{config.maxGradeAttempts}</td></tr>
            <tr>
              <td>Break-even hit rate (from the default payout)</td>
              <td className="num">{(BREAK_EVEN_RATE * 100).toFixed(1)}%</td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <ActionButton
            action={runGrader}
            label="Run grader now"
            pendingLabel="Grading..."
            confirmTitle="Run the grader now?"
            confirm={["Every pick that has reached its grading time will be graded against its box score."]}
            confirmLabel="Run grader"
            disabledReason={
              countOf(null) === 0 ? "No pick is waiting to be graded." : null
            }
          />
        </div>
      </section>

      <section className="chart-card" id="closing-config">
        <h3>How the closing read is configured</h3>
        <p className="lede">Change these in <code>server/.env</code> and restart the server.</p>
        <table>
          <tbody>
            <tr>
              <td>Closing read window</td>
              <td className="num">{CLOSING_WINDOW_DESCRIPTION}</td>
            </tr>
            <tr>
              <td>Late-read threshold</td>
              <td className="num">{config.staleCaptureMinutes} min</td>
            </tr>
            <tr>
              <td>Retries before giving up</td>
              <td className="num">{config.maxFetchAttempts}</td>
            </tr>
            <tr>
              <td>Default pick&apos;em payout (used when the board shows none)</td>
              <td className="num">{DEFAULT_PICKEM_PRICE}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="chart-card" id="ingest-failures">
        <h3>Ingest failures</h3>
        <p className="lede">
          Every pick the extension tried to send but that could not be tracked — a malformed
          payload, a shape the schema forbids (a player prop with no player, a spread with no
          team), or an error thrown while writing it. Reasons like these used to only ever reach a
          server log nobody was watching; they land here instead.
        </p>

        {ingestFailures.length === 0 ? (
          <p className="muted">
            No ingest failures recorded{ingestFailureTotal > 0 ? " in the most recent batch" : ""} —
            every tick the extension has sent was tracked.
          </p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Stage</th>
                  <th>Reason</th>
                  <th>Pick</th>
                  <th>Debug</th>
                </tr>
              </thead>
              <tbody>
                {ingestFailures.map((f) => (
                  <tr key={f.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{fmt(f.occurredAt)}</td>
                    <td>
                      <span className="badge bad">{STAGE_LABEL[f.stage] ?? f.stage}</span>
                    </td>
                    <td className="err" style={{ fontFamily: "inherit" }}>{f.reason}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {[f.site, f.sport, f.player, f.statMarket].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td>
                      {(f.payloadJson || f.stack) && (
                        <details>
                          <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                            raw
                          </summary>
                          {f.stack && (
                            <pre className="err" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                              {f.stack}
                            </pre>
                          )}
                          {f.payloadJson && (
                            <pre
                              className="muted"
                              style={{
                                whiteSpace: "pre-wrap",
                                fontSize: 11,
                                maxHeight: 260,
                                overflow: "auto",
                                margin: 0,
                              }}
                            >
                              {f.payloadJson}
                            </pre>
                          )}
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12 }}>
              Showing the {ingestFailures.length} most recent of {ingestFailureTotal} recorded.
            </p>
            <div style={{ marginTop: 14 }}>
              <ActionButton
                action={clearIngestFailuresAction}
                label="Clear log"
                pendingLabel="Clearing..."
                danger
                confirmTitle="Clear the ingest failure log?"
                confirm={[`All ${ingestFailureTotal} recorded failure(s) will be removed. This cannot be undone.`]}
                confirmLabel="Clear log"
              />
            </div>
          </>
        )}
      </section>

        </div>
      </div>
    </main>
  );
}
