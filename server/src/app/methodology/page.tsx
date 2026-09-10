export const dynamic = "force-static";

export default function MethodologyPage() {
  return (
    <main className="prose">
      <h2 style={{ marginTop: 0 }}>Methodology</h2>
      <p>
        Every number on this dashboard comes from two reads of the same prop: the board as it looked
        when you ticked the pick, and PropProfessor&apos;s odds screen shortly before kickoff.
        Nothing is modelled or estimated — if a number cannot be derived from those two reads, it is
        left blank rather than filled in with a guess.
      </p>
      <p className="muted">
        The close is deliberately <em>not</em> read from the optimizer the pick was taken on. An
        optimizer only lists props that still have edge, so a pick whose line genuinely moved — the
        ones most worth measuring — would be missing from it by kickoff and get recorded as
        unavailable. The odds screen lists every market whether or not any edge is left.
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
      <ul>
        <li>
          <strong>Prices nobody would take</strong>. A quote priced far from even money on a prop is
          not a line anyone is really offering — usually a single resting order on an exchange,
          where anyone can set the price. Its line often looks ordinary, so the giveaway is the
          price rather than the number.
        </li>
        <li>
          <strong>Books far from the rest of the field</strong>. Feeds go stale, and one bad quote
          moves an average a long way. A book whose line sits outside a median-absolute-deviation
          band around the others is dropped and named in the note on the pick&apos;s detail page.
          Moneylines are compared as implied probabilities rather than American odds, which are far
          too non-linear to average or measure distance on. Exchanges (Novig, Prophet X, Kalshi,
          Polymarket) are held to a tighter tolerance and are never allowed to define the consensus
          they are judged against.
        </li>
      </ul>
      <p>
        Every column is still stored and shown on the pick&apos;s detail page, greyed and marked
        &quot;not averaged&quot;.
      </p>
      <p>
        Because the screen lists one selection per line rather than one column per book, each
        book&apos;s own main line is rebuilt across all of a market&apos;s selections: the line where
        that book&apos;s price is least lopsided, which is what distinguishes its real number from
        an alt. Other lines it quoted are recorded alongside rather than discarded.
      </p>
      <p>
        If the market is listed at close but this selection is not in it — a scratch, or a pulled
        prop — the pick is marked <code>UNAVAILABLE</code>. If no sportsbook prices that market at
        all, such as a DFS-only fantasy-score composite, it is marked{" "}
        <code>NO_CLOSING_MARKET</code>. Both are excluded from all rates and neither is ever counted
        as a loss; they are kept apart because one is a missing selection and the other is a
        statement about the market itself.
      </p>
      <p className="muted">
        Verdicts recorded before September 2026 were measured against the optimizer, which showed
        fewer books, and are stamped <code>OPTIMIZER_LEGACY</code>. The two methods produce
        different closing averages for the same pick and are not directly comparable.
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

      <h3 id="grading">Grading: did the pick actually win?</h3>
      <p>
        Results come from official box scores, fetched by the server a few hours after kickoff:{" "}
        <strong>ESPN</strong> for NFL, college football and NBA, and the{" "}
        <strong>MLB StatsAPI</strong> for baseball. Nothing is modelled or estimated — a pick is
        settled only when the game is confirmed final and the player&apos;s line is read directly
        from the box score. Every automatic grade links to the box score it came from, so any
        result can be checked in one click.
      </p>
      <p>
        Only full-game counting stats are graded: yards, receptions, completions, points, rebounds,
        assists, hits, runs, RBIs and simple sums of those. Anything else is left explicitly
        ungraded rather than guessed at.
      </p>

      <h3 id="push">Pushes</h3>
      <p>
        Pick&apos;em lines are often whole numbers, so a stat can land exactly on the line — 14
        fantasy points against a line of 14. That is a <strong>push</strong>: excluded from both
        the numerator and the denominator of hit rate, never counted as a loss. A half-point line
        can never push.
      </p>

      <h3 id="void">Voids</h3>
      <p>
        If a player was inactive, or the game was postponed, suspended or cancelled, the pick is{" "}
        <strong>void</strong> — there was no result to settle against. This matters more than it
        sounds: treating an inactive player as zero would silently hand every Under on him a win.
      </p>

      <h3 id="break-even">Why hit rate is not coloured against 50%</h3>
      <p>
        A pick&apos;em leg pays less than even money, so winning half the time is a losing record.
        Hit rate is coloured against the break-even implied by the configured payout — at the
        default −119 that is <strong>54.3%</strong>. A 52% hit rate is red, not green, because it
        loses money.
      </p>

      <h3 id="ungradeable">What cannot be graded automatically</h3>
      <ul>
        <li>
          <strong>Fantasy-score composites</strong> — the scoring formula differs by book, and a
          wrong constant would mis-grade every pick while looking perfectly plausible.
        </li>
        <li>
          <strong>CS2 and other esports</strong> — no free source exposes per-map player stats
          (the available HLTV scraper has no headshots field at all).
        </li>
        <li>
          <strong>Tennis</strong> — ESPN publishes no per-player match statistics such as aces.
        </li>
        <li>
          <strong>Partial-game markets</strong> (first half, a single quarter) — only full-game box
          scores are available, so grading them would compare the wrong span.
        </li>
        <li>Any market not yet mapped to a box-score field, named explicitly in the pick&apos;s reason.</li>
      </ul>
      <p>
        All of these can be <a href="#manual-grade">graded by hand</a>, so they still count.
      </p>

      <h3 id="manual-grade">Manual grades</h3>
      <p>
        Entering a result by hand records the actual value and derives win/loss/push from it with
        the same rule the automatic grader uses, so the stored number and the stored result can
        never disagree. Manual grades are tagged as such wherever they appear, and can be filtered
        out to check the automatically verified numbers on their own.
      </p>

      <h3 id="clv-vs-result">Does beating CLV predict hitting?</h3>
      <p>
        This is the point of tracking CLV at all, and grading makes it testable. The analysis page
        compares the hit rate of picks that beat the close against those that missed it, overall
        and per sport. The difference (&quot;lift&quot;) is in percentage points: positive means
        beating the close really did coincide with winning more often.
      </p>
      <p>
        Only picks with <em>both</em> a CLV verdict and a decided result can appear in that
        comparison, and every cell shows its sample size — with a few dozen picks a large lift can
        easily be noise.
      </p>

      <h3 id="expectation">Running above or below expectation</h3>
      <p>
        Each pick&apos;s EV% is what it should return per unit staked, on average. Adding those up
        across graded picks gives the profit the edge implies; adding up the actual wins and losses
        at the pick&apos;em payout gives what really happened. The difference is variance.
      </p>
      <p>
        It is deliberately <em>not</em> a measure of whether the picks were good: a positive gap
        means you ran hot, not that you picked better. Both sides are computed over the same
        sample — picks that are both graded and carry an EV number — so the comparison is like for
        like.
      </p>

      <h3 id="odds-links">Links to current odds</h3>
      <p>
        Each pick links back to the board it came from, and to the site&apos;s odds screen.
        OddsJam encodes sport and market in its URL, so that link opens already filtered — e.g.{" "}
        <code>/nfl/screen/player-passing-yards</code>. Neither site accepts a player in the URL, so
        the last step is their own search box; the detail page offers a one-click copy of the
        player&apos;s name for that.
      </p>
      <p>
        PropProfessor cannot be pre-filled at all: its screen keeps filter state in memory, so
        changing a dropdown never changes the URL and loading the page with query parameters is
        ignored. That link therefore opens the plain screen.
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
