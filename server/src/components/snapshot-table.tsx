import { fmtOdds } from "@/components/ui";

export interface LineRow {
  id: string;
  bookKey: string;
  label: string | null;
  line: number | null;
  price: number | null;
  /** This book's price at `atLine`, where it quotes that line. Only the live read fills it. */
  priceAtLine?: number | null;
  logoUrl: string | null;
  includedInAverage: boolean;
}

/**
 * Renders one side of a book-line comparison -- "When you took it" / "At market close" on a bet's
 * own page, and the live read in the Odds modal (`odds-preview-modal.tsx`). Kept as one component
 * so all three read the same way and a change to one doesn't quietly drift from the others.
 *
 * `atLine` is what adds the fourth column: the pick's own number, priced separately, for when the
 * books have moved off it. Left out everywhere else, so the two snapshot tables on a bet page are
 * exactly the three columns they have always been.
 */
export function SnapshotTable({
  title,
  when,
  lines,
  emptyNote,
  atLine = null,
}: {
  title: string;
  when: string;
  lines: LineRow[];
  emptyNote: string;
  atLine?: number | null;
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
              {atLine !== null && <th className="num">At {atLine}</th>}
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
                {atLine !== null && <td className="num">{fmtOdds(l.priceAtLine ?? null)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
