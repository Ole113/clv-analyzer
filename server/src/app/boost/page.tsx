import { BoostCalculator } from "@/components/boost-calculator";

// Every number on this page is derived in the browser from what you type; there is nothing to fetch.
export const dynamic = "force-static";

export default function BoostPage() {
  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Profit boost EV</h2>
      <p className="muted" style={{ maxWidth: 760, marginTop: 0 }}>
        Whether a profit boost is worth using on a slip, given what the legs are really worth. A
        3-leg at -122 a leg needs 55.0% a leg to break even; a 25% boost drops that to 51.6%, which
        is what turns three 54% props from a loser into a winner.
      </p>
      <BoostCalculator />
    </main>
  );
}
