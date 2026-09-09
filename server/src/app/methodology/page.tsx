export const dynamic = "force-static";

export default function MethodologyPage() {
  return (
    <main className="prose">
      <h2 style={{ marginTop: 0 }}>Methodology</h2>
      <p>
        Every number on this dashboard comes from two snapshots of the same prop: the board as it
        looked when you ticked the pick, and the board a couple of minutes after kickoff. Nothing
        is modelled or estimated — if a number cannot be derived from those two reads, it is left
        blank rather than filled in with a guess.
      </p>

      <h3 id="clv">Closing line value (CLV)</h3>
      <p>
        CLV asks whether the market moved toward you between your bet and the close. It is measured
        on the <strong>line</strong>, not the price:
      </p>
      <div className="formula">
        edge = avgClosingLine − takenLine (Over)
        <br />
        edge = takenLine − avgClosingLine (Under)
        <br />
        beatClv = edge &gt; 0
      </div>
      <p>
        An Over beats the close when the number moved <em>up</em>: you needed fewer than the market
        later demanded. An Under beats it when the number moved <em>down</em>. A line that finishes
        exactly where you took it is not a win — no edge was gained — so a flat line counts as not
        beating the close.
      </p>

      <h3 id="consensus">The closing average</h3>
      <p>
        <code>avgClosingLine</code> is the unweighted mean of the closing lines across the real
        sportsbooks that were still quoting the prop. Two kinds of column are deliberately left
        out:
      </p>
      <ul>
        <li>
          <strong>Pick&apos;em apps</strong> (PrizePicks, Underdog, Betr, Sleeper, ParlayPlay…).
          Their number is a fixed-payout threshold, not a market price — averaging them in would
          partly compare the pick against itself.
        </li>
        <li>
          <strong>Derived columns</strong>, such as OddsJam&apos;s &quot;Algo Odds&quot;, which is a
          computed price rather than a book quoting a market.
        </li>
      </ul>
      <p>
        Every column is still stored and shown on the pick&apos;s detail page, greyed and marked
        &quot;not averaged&quot;. If no sportsbook is still quoting the prop at close, the pick is
        marked <code>UNAVAILABLE</code> and excluded from all rates — it is never counted as a loss.
      </p>

      <h3 id="ev">Expected value (EV%)</h3>
      <div className="formula">EV% = fairProbability × decimalPayout − 1</div>
      <p>
        The fair probability is the site&apos;s own no-vig column — OddsJam&apos;s &quot;% chance to
        hit&quot;, PropProfessor&apos;s &quot;Value&quot;. That column is used rather than one
        derived here for a specific reason: it is already de-vigged <em>and</em> quoted at the exact
        line you took. The raw book cells cannot give this. They show one price per book at{" "}
        <em>that book&apos;s own line</em>, so there is no opposing side to de-vig against, and no
        way to re-price a 62.5 pick from a book hanging 90.5 without inventing a distribution.
      </p>
      <p>
        The payout is the pick&apos;em price from the DFS column when the board shows one, otherwise
        the configured default (see Settings). Picks captured before EV capture was added carry no
        EV% and are excluded from EV averages — the analysis page reports how many of the filtered
        picks actually carry one.
      </p>

      <h3 id="book-favorability">Book favourability</h3>
      <div className="formula">
        favourability = consensus − bookLine (Over)
        <br />
        favourability = bookLine − consensus (Under)
      </div>
      <p>
        For each book still quoting the prop at close, this measures how its number compared with
        the consensus, oriented to the side you were on. Positive means the book offered a friendlier
        number than the market; negative means it habitually hung a worse one. Averaged per book —
        and per book per prop type — this is what the &quot;worst sportsbooks&quot; ranking sorts on.
      </p>

      <h3 id="beat-rate">Beat rate and sample</h3>
      <p>
        Beat rate is the share of <em>settled</em> picks with <code>edge &gt; 0</code>. Only picks
        with the status <code>CLOSED</code> count. Picks that are pending, unavailable, or whose
        closing read failed are excluded from the numerator and denominator alike, and surfaced
        separately so a thin or broken sample is visible rather than hidden inside an average.
      </p>

      <h3 id="late">Late reads</h3>
      <p>
        The closing board is read by the extension in your own browser, so Chrome has to be running
        near kickoff. If it was not, the pick is read whenever a browser next comes online and the
        gap is recorded. Beyond the configured threshold (default 20 minutes) the pick is flagged as
        a late read: the lines are post-game, not closing, and the detail page says so.
      </p>
    </main>
  );
}
