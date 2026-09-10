import { decimalFromAmerican, DEFAULT_PICKEM_PRICE } from "@/lib/ev";
import { sideLabel } from "./ui";

interface Line {
  bookKey: string;
  label: string | null;
  line: number | null;
  includedInAverage: boolean;
}

interface MathBet {
  marketType: string;
  side: string | null;
  takenLine: number;
  openFairProb: number | null;
  closeFairProb: number | null;
  fantasyPrice: number | null;
  openEvPercent: number | null;
  closeEvPercent: number | null;
  avgClosingLine: number | null;
  closingBookCount: number | null;
  edge: number | null;
  beatClv: boolean | null;
  isLive: boolean;
  closeLines: Line[];
}

function pct(value: number | null): string {
  return value === null ? "--" : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number | null, digits = 2): string {
  if (value === null) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** One line of working: the formula, the numbers substituted in, and the answer. */
function Step({ label, formula, substituted, result }: {
  label: string;
  formula: string;
  substituted: string;
  result: string;
}) {
  return (
    <div className="math-step">
      <div className="math-label">{label}</div>
      <code className="math-formula">{formula}</code>
      <code className="math-sub">{substituted}</code>
      <div className="math-result">= {result}</div>
    </div>
  );
}

/**
 * The arithmetic behind the three headline numbers, shown on demand.
 *
 * Collapsed by default: the point of the dashboard is the verdict, not the working. But every
 * number here is derived from two board reads, and being able to check one against the other is
 * what makes the verdict trustworthy rather than something to take on faith.
 */
export function MathBreakdown({ bet }: { bet: MathBet }) {
  const averaged = bet.closeLines.filter((l) => l.includedInAverage && l.line !== null);
  const effectivePrice = bet.fantasyPrice ?? DEFAULT_PICKEM_PRICE;
  const decimal = decimalFromAmerican(effectivePrice);

  const spread = bet.marketType === "SPREAD";
  const moneyline = bet.marketType === "MONEYLINE";
  // Line for everything else, price for a moneyline -- same taken-minus-close subtraction either
  // way (see MARKET_TYPES in server/src/lib/constants.ts for why the sign works out the same).
  const unit = moneyline ? "price" : "line";
  const under = bet.side === "UNDER";
  const edgeFormula =
    spread || moneyline
      ? `edge = ${unit} you took − average closing ${unit}`
      : under
        ? "edge = line you took − average closing line"
        : "edge = average closing line − line you took";

  return (
    <details className="math">
      <summary>
        Show the math
        <span className="muted"> — how EV%, edge and the average close were calculated</span>
      </summary>

      <div className="math-body">
        {/* --- average close --- */}
        <section>
          <h4>Average closing {unit}</h4>
          {bet.avgClosingLine === null ? (
            <p className="muted">
              No closing {unit} was recorded, so there is no average to show.
            </p>
          ) : averaged.length > 0 ? (
            <>
              <p className="muted">
                {moneyline
                  ? "Only real sportsbooks quoting a price count. Pick’em apps and derived columns are stored but excluded, same as any other market."
                  : "Only real sportsbooks quoting a line count. Pick’em apps and derived columns are stored but excluded, because their number is a fixed payout threshold rather than a market price."}
              </p>
              <table className="math-table">
                <tbody>
                  {averaged.map((l) => (
                    <tr key={l.bookKey}>
                      <td>{l.label ?? l.bookKey}</td>
                      <td className="num">{l.line}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Step
                label={`Mean of the ${unit}s above`}
                formula={`avg = sum of ${unit}s ÷ number of books`}
                substituted={`(${averaged.map((l) => l.line).join(" + ")}) ÷ ${averaged.length}`}
                result={bet.avgClosingLine.toFixed(4)}
              />
            </>
          ) : (
            <p className="muted">
              The books on this board quote a price rather than a line, so the closing number is
              the line the market itself showed at close ({bet.avgClosingLine}), not a consensus
              of book lines.
            </p>
          )}
        </section>

        {/* --- edge --- */}
        <section>
          <h4>CLV edge</h4>
          {bet.isLive ? (
            <p className="muted">
              This pick was taken in-play, so there is no closing line to measure against — the
              line was already mid-game when you took it.
            </p>
          ) : bet.avgClosingLine === null || bet.edge === null ? (
            <p className="muted">No closing line was recorded, so no edge could be computed.</p>
          ) : (
            <>
              <p className="muted">
                {spread
                  ? "On a spread, holding more points than the close is the win — the opposite direction to a total."
                  : moneyline
                    ? "On a moneyline, the price moving further in the pick's favour after capture is the win: a shorter favourite price or a bigger underdog price both mean the close demanded worse odds than you got."
                    : under
                      ? "An Under beats the close when the number moves down: you needed fewer than the market later demanded."
                      : "An Over beats the close when the number moves up: you needed fewer than the market later demanded."}
              </p>
              <Step
                label={`${spread ? "Spread" : moneyline ? "Moneyline" : sideLabel(bet.side) || "Over"} edge`}
                formula={edgeFormula}
                substituted={
                  spread || moneyline || under
                    ? `${bet.takenLine} − ${bet.avgClosingLine.toFixed(4)}`
                    : `${bet.avgClosingLine.toFixed(4)} − ${bet.takenLine}`
                }
                result={`${signed(bet.edge)} — ${bet.beatClv ? "beat the close" : "did not beat the close"}`}
              />
              <p className="muted">
                A perfectly flat line does not count as beating the close: no edge was gained.
              </p>
            </>
          )}
        </section>

        {/* --- EV --- */}
        <section>
          <h4>Expected value</h4>
          <p className="muted">
            The fair win probability is the board&apos;s own no-vig number, quoted at the exact
            line you took. It cannot be derived from the book cells: they each show one price at
            that book&apos;s own line, so there is no opposing side to de-vig against.
          </p>
          {bet.openFairProb === null && bet.openEvPercent !== null ? (
            <p className="muted">
              This board publishes an EV% directly rather than a win probability, so{" "}
              <strong>{signed(bet.openEvPercent, 2)}%</strong> is recorded as the board stated it.
            </p>
          ) : bet.openFairProb === null ? (
            <p className="muted">No fair probability was captured for this pick.</p>
          ) : (
            <>
              <Step
                label="At capture"
                formula="EV% = fair probability × decimal payout − 1"
                substituted={`${pct(bet.openFairProb)} × ${decimal ? decimal.toFixed(4) : "--"} − 1`}
                result={`${signed(bet.openEvPercent, 2)}%`}
              />
              <p className="muted">
                Payout {effectivePrice > 0 ? `+${effectivePrice}` : effectivePrice}
                {bet.fantasyPrice === null
                  ? " (the board showed no DFS column, so the configured default was used)"
                  : " (from the board's own DFS column)"}
                .
              </p>
              {bet.closeFairProb !== null && (
                <Step
                  label="At close"
                  formula="EV% = fair probability × decimal payout − 1"
                  substituted={`${pct(bet.closeFairProb)} × ${decimal ? decimal.toFixed(4) : "--"} − 1`}
                  result={`${signed(bet.closeEvPercent, 2)}%`}
                />
              )}
            </>
          )}
        </section>
      </div>
    </details>
  );
}
