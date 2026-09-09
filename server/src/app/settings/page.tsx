import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { config } from "@/lib/constants";
import { DEFAULT_PICKEM_PRICE } from "@/lib/ev";
import { PurgeForm } from "@/components/purge-form";

export const dynamic = "force-dynamic";

const UNIT_HOURS: Record<string, number> = { days: 24, weeks: 24 * 7, months: 24 * 30 };

export default async function SettingsPage() {
  const [total, oldest, newest, demo] = await Promise.all([
    prisma.bet.count(),
    prisma.bet.findFirst({ orderBy: { openCapturedAt: "asc" }, select: { openCapturedAt: true } }),
    prisma.bet.findFirst({ orderBy: { openCapturedAt: "desc" }, select: { openCapturedAt: true } }),
    prisma.bet.count({ where: { sourceDevice: "demo-seed" } }),
  ]);

  /** Counts what a purge would remove, so the confirmation can name a real number. */
  async function countPurge(amount: number, unit: string): Promise<number> {
    "use server";
    const hours = (UNIT_HOURS[unit] ?? 24) * amount;
    const cutoff = new Date(Date.now() - hours * 3600_000);
    return prisma.bet.count({ where: { openCapturedAt: { gte: cutoff } } });
  }

  /** Deletes picks captured within the last N days/weeks/months. Snapshots cascade with them. */
  async function purgeRecent(amount: number, unit: string): Promise<number> {
    "use server";
    const hours = (UNIT_HOURS[unit] ?? 24) * amount;
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const { count } = await prisma.bet.deleteMany({ where: { openCapturedAt: { gte: cutoff } } });
    revalidatePath("/settings");
    revalidatePath("/bets");
    revalidatePath("/analysis");
    revalidatePath("/");
    return count;
  }

  async function purgeDemo(): Promise<number> {
    "use server";
    const { count } = await prisma.bet.deleteMany({ where: { sourceDevice: "demo-seed" } });
    revalidatePath("/settings");
    revalidatePath("/bets");
    return count;
  }

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
          {demo > 0 && <> · {demo} are demo rows</>}
        </p>

        <PurgeForm countAction={countPurge} purgeAction={purgeRecent} />

        {demo > 0 && (
          <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <PurgeForm demoOnly demoCount={demo} purgeDemoAction={purgeDemo} />
          </div>
        )}
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
