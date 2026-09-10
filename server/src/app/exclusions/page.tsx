import { getExclusionAudit } from "@/lib/queries";
import { betTitle, sideLabel } from "@/components/ui";
import { Info } from "@/components/info";

export const dynamic = "force-dynamic";

/**
 * Which books keep getting dropped from the closing average.
 *
 * A page rather than a section on /settings because the interesting reading is the examples: the
 * rate alone says a book is suspect, but only the side-by-side of what it had up against what the
 * field had tells you *which kind* of suspect -- a genuinely stale feed, or the same `bookKey`
 * pointed at a different market (an alt-line column admitted as a main one, a mis-normalised label
 * collapsing two books into one). Those need opposite fixes, and the note on a single pick's
 * detail page cannot distinguish them.
 */
export default async function ExclusionsPage() {
  const audit = await getExclusionAudit();

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Excluded books</h2>
      <p className="lede">
        A book whose closing number sits far outside the rest of the field is dropped from the
        average for that pick. Here that is counted across every pick instead of being buried one
        sentence at a time on individual detail pages.
      </p>

      <div className="tiles">
        <div className="tile">
          <div className="label">Picks with a closing read</div>
          <div className="value">{audit.picksWithClose}</div>
          <div className="sub">the population these rates are over</div>
        </div>
        <div className="tile">
          <div className="label">Picks with an exclusion</div>
          <div className="value">{audit.picksWithExclusions}</div>
          <div className="sub">
            {audit.picksWithClose > 0
              ? `${((audit.picksWithExclusions / audit.picksWithClose) * 100).toFixed(1)}% of closing reads`
              : "no closing reads yet"}
          </div>
        </div>
        <div className="tile">
          <div className="label">
            Books ever dropped
            <Info title="What this is for" anchor="consensus">
              One rejection is a stale feed. The same book rejected on a large share of the picks it
              appears on is a different problem — usually a mis-mapped book key, where one name is
              being matched to a different market or to an alt-line column. Only the rate across
              picks separates the two.
            </Info>
          </div>
          <div className="value">{audit.books.length}</div>
          <div className="sub">sorted by how often, not how many</div>
        </div>
      </div>

      {audit.books.length === 0 ? (
        <p className="muted">
          {audit.picksWithClose === 0
            ? "No closing lines have been captured yet, so nothing has been excluded."
            : "No book has been dropped from a closing average yet — the fields have all agreed."}
        </p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Book</th>
                <th className="num">Dropped</th>
                <th className="num">Seen at close</th>
                <th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {audit.books.map((b) => (
                <tr key={b.bookKey}>
                  <td>
                    {b.label}{" "}
                    <span className="muted" style={{ fontSize: 11 }}>
                      {b.bookKey}
                    </span>
                  </td>
                  <td className="num">{b.excluded}</td>
                  <td className="num">{b.seen}</td>
                  <td className="num">
                    {/* Deliberately not <Rate>, which colours a high number green: here a high
                        rejection rate is the bad outcome, not the good one. Any rejection is worth
                        a look, and a quarter of appearances is where it stops looking like bad
                        luck -- the seen count beside it says whether the rate means anything yet. */}
                    <span className={`val ${b.rate >= 0.25 ? "bad" : "warn"}`}>
                      {(b.rate * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12 }}>
            Treat a small &quot;seen&quot; count with suspicion: a book quoted twice and dropped
            twice is a 100% rate over nothing.
          </p>

          <h2>What was actually rejected</h2>
          <p className="lede muted" style={{ fontSize: 12, marginTop: -4 }}>
            The book&apos;s number against the consensus it was measured from, on the most recent
            picks it was dropped on. A consistent, similar-sized gap in one direction is the
            signature of a mis-mapping rather than of noise.
          </p>
          {audit.books.map((b) => (
            <section className="chart-card" key={b.bookKey}>
              <h3>
                {b.label}{" "}
                <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                  dropped on {b.excluded} of {b.seen}
                  {/* The table below is only ever the most recent handful, capped in
                      getExclusionAudit -- without this, "dropped on 38 of 41" next to a 5-row
                      table read as a bug rather than a deliberate sample. */}
                  {b.examples.length < b.excluded &&
                    ` — showing the ${b.examples.length} most recent`}
                </span>
              </h3>
              <table>
                <thead>
                  <tr>
                    <th>Pick</th>
                    <th className="num">{b.label} had</th>
                    <th className="num">Field closed</th>
                    <th className="num">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {b.examples.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <a href={`/bets/${e.id}`}>
                          {betTitle({
                            player: e.player,
                            selectionName: e.selectionName,
                            side: e.side,
                            takenLine: e.takenLine,
                            statMarket: e.statMarket,
                          })}
                        </a>{" "}
                        <span className="muted" style={{ fontSize: 11 }}>
                          {e.statMarket}
                          {e.side ? ` · ${sideLabel(e.side)}` : ""}
                        </span>
                      </td>
                      <td className="num">{e.line ?? "--"}</td>
                      <td className="num">
                        {e.consensus === null ? "--" : e.consensus.toFixed(2)}
                      </td>
                      <td className="num">
                        {/* Uncoloured on purpose. The sign here says which side of the field the
                            book sat on, not whether that was good or bad for you -- a book 60
                            above the consensus is equally wrong whichever way you were betting,
                            and the green a signed value would give it reads as the opposite. */}
                        {e.line !== null && e.consensus !== null ? (
                          <span className="val flat">
                            {e.line - e.consensus > 0 ? "+" : ""}
                            {(e.line - e.consensus).toFixed(2)}
                          </span>
                        ) : (
                          <span className="muted">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
