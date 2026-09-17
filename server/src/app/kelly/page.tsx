import { KellyCalculator } from "@/components/kelly-calculator";
import { getAppSettings } from "@/lib/app-settings";

// Reads the bankroll and multiplier off the settings row, so this page and the extension's Kelly
// button stake against the same number.
export const dynamic = "force-dynamic";

export default async function KellyPage() {
  const { kelly } = await getAppSettings();

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Kelly stake</h2>
      <p className="muted" style={{ maxWidth: 760, marginTop: 0 }}>
        How much to put on a line that is off the market. Fliff has it at -110 and every other book
        is at -140, so the price is 30 points better than fair: that is +11.36% EV, 12.5% of bankroll
        at full Kelly, and $156.25 of a $5,000 roll at the quarter Kelly most people actually bet.
      </p>
      <p className="muted" style={{ maxWidth: 760 }}>
        The multiplier scales down full Kelly, which is the stake that grows a bankroll fastest if
        the fair price entered is exactly right. It never is — a fair price is an estimate, not a
        certainty — and full Kelly punishes being wrong hard: it swings bankroll violently on a bad
        estimate and can wipe out most of it on a bad streak. A lower multiplier (like the 0.25
        default) trades away some of that upside for a much smoother ride when the estimate is off;
        a higher one bets closer to what full Kelly says and rides bigger swings both ways. 1 is full
        Kelly.
      </p>
      <KellyCalculator
        bankroll={kelly.bankroll}
        multiplier={kelly.kellyMultiplier}
        unitSize={kelly.unitSize}
      />
    </main>
  );
}
