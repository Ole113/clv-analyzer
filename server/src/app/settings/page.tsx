import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/constants";
import { DEFAULT_PICKEM_PRICE } from "@/lib/ev";
import { PurgeForm } from "@/components/purge-form";
import { TestDataForm } from "@/components/test-data-form";
import { BookSettingsForm } from "@/components/book-settings-form";
import { ActionButton, type ActionResult } from "@/components/action-button";
import { runDueGrades } from "@/lib/grading/grader";
import { BREAK_EVEN_RATE } from "@/lib/ev";
import { generateTestData, TEST_DATA_SOURCE_DEVICES, MAX_TEST_DATA_PER_REQUEST } from "@/lib/test-data";
import { getAppSettings, knownBooks, saveBookOrder, saveBookWeights } from "@/lib/app-settings";

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
    useWeightedAverage: boolean
  ): Promise<void> {
    "use server";
    await Promise.all([saveBookOrder(order), saveBookWeights(weights, useWeightedAverage)]);
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

  const gradeCounts = await prisma.bet.groupBy({ by: ["gradeResult"], _count: true });
  const countOf = (result: string | null) =>
    gradeCounts.find((g) => g.gradeResult === result)?._count ?? 0;

  const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString() : "--");

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <section className="chart-card">
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

      <section className="chart-card">
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
          saveAction={saveBookSettingsAction}
        />
      </section>

      <section className="chart-card">
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

      <section className="chart-card">
        <h3>How the closing read is configured</h3>
        <p className="lede">Change these in <code>server/.env</code> and restart the server.</p>
        <table>
          <tbody>
            <tr>
              <td>Closing buffer</td>
              <td className="num">{config.closingBufferMinutes} min after kickoff</td>
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
    </main>
  );
}
