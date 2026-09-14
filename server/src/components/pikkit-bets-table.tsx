import type { PikkitBetRow } from "@/lib/pikkit/queries";
import { fmtDateTime } from "@/components/ui";
import { splitTagSet } from "@/lib/pikkit/parse";

/**
 * The imported slips, as placed.
 *
 * A plain Server Component table rather than a second `BetsTable`: that one's sorting, grouping
 * and right-click actions all operate on captured picks (grade it, void it, price it now), none of
 * which mean anything for a settled bet imported from a book. What this list is for is looking up
 * what a row in the charts above was actually made of, so the legs are the point and everything
 * else is context.
 */
function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function ResultCell({ result }: { result: string }) {
  const cls =
    result === "WIN" ? "good" : result === "LOSS" ? "bad" : result === "VOID" ? "neutral" : "warn";
  const label = result === "PENDING" ? "Open" : result[0] + result.slice(1).toLowerCase();
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function PikkitBetsTable({ bets }: { bets: PikkitBetRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Placed</th>
          <th>Book</th>
          <th>Bet</th>
          <th>League</th>
          <th className="num">Odds</th>
          <th className="num">Close</th>
          <th className="num">Stake</th>
          <th className="num">Profit</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {bets.map((bet) => (
          <tr key={bet.id}>
            <td>{fmtDateTime(bet.placedAt)}</td>
            <td>
              {bet.sportsbook}
              {bet.isLive && <span className="live-chip">Live</span>}
            </td>
            <td>
              {/* Every leg, not a truncated summary: on a four-leg slip the legs are the only
                  thing that distinguishes it from the other four-leg slip placed that minute. */}
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {bet.legs.map((leg) => (
                  <li key={leg.legIndex}>{leg.rawText}</li>
                ))}
              </ul>
            </td>
            <td>{splitTagSet(bet.leaguesRaw).join(", ") || <span className="muted">--</span>}</td>
            <td className="num">{bet.oddsDecimal.toFixed(2)}</td>
            <td className="num">
              {bet.closingDecimal === null ? (
                <span className="muted">--</span>
              ) : (
                bet.closingDecimal.toFixed(2)
              )}
            </td>
            <td className="num">{money(bet.stake)}</td>
            <td className="num">
              <span className={`val ${bet.profit > 0 ? "good" : bet.profit < 0 ? "bad" : "flat"}`}>
                {bet.profit > 0 ? "+" : ""}
                {money(bet.profit)}
              </span>
            </td>
            <td><ResultCell result={bet.result} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
