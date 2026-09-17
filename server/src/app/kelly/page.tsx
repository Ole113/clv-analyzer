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
      <KellyCalculator
        bankroll={kelly.bankroll}
        multiplier={kelly.kellyMultiplier}
        unitSize={kelly.unitSize}
      />
    </main>
  );
}
