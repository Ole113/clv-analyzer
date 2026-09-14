## Future Additions

**_ There might be a better way to calculate odds at closing time.... maybe we use something like https://picktheodds.app/en/odds-screen/MLB?group=PLAYER_PROP_RUN&time=PLAYER_PROP_RUN&betGroup=PLAYER_PROP or https://4codds.com/football/nfl/props#p-6a71858e10c4a746d32aa8f2_**

- Might be worth doing some testing of calculating some odds with these and some the old way with PP and see how much of a difference it makes.
  \*\* Maybe even a plugin with these odds pages to search up players. Somethign like where you triple click on the row and it pulls a injected table of all teh lines on it from these softwares

- Add some way to use the width of a market to do some analyzing. Could even just be an "i" stat next to book line on the book snapshots
- Dry-run mode for closing reads: `POST /api/closing-snapshots?dryRun=1` returning the verdict it _would_ record without writing, so a live slate can be compared against the old method before trusting the new one.
- Surface alt-line picks: a DFS pick taken at 40.5 against a 62.5 consensus produces a very large edge that is arguably correct but will distort a chart. The per-book alt lines are already recorded on each row.

~~Add a way to export your pikkit betting information and back test your bets.~~ Done: import the
Pikkit CSV on /analysis?source=pikkit. Per sport, book and prop type are all there, in ROI rather
than win % (a win % means little across books paying 1.8 and 6.0), plus price, stake, day-of-week
and hour-of-day bands, streaks, and a confidence interval on the ROI. Still open from this:

- Per-leg results. The export settles the slip only, so leg breakdowns are exposure, not hit rate.
  Nothing short of a different data source can fix that.
- The leg parser finds a market from a vocabulary (`server/src/lib/pikkit/markets.ts`). A book that
  starts spelling one a new way needs an entry there, or those legs drop out of the market
  breakdown -- silently, since the slip still counts everywhere else.

Brainstorm additions to the project

- Think of analytical additions.
- Think of ways to get a more accurate EV calculation and clv calculation.
- Any additional pages to add that might be useful for my analytical analysis of my +ev betting.
- Any additional integrations to add that might be useful for my analytical analysis of my +ev betting

Grade 1st-quarter/1st-half (and other partial-game) markets automatically, for NFL and NBA at least. Currently anything matching that pattern is refused up front (`unsupportedReason` in `server/src/lib/grading/stat-map.ts`) because the box-score source only has full-game cumulative stats. Split by what's actually being asked:

- Team score/total/spread scoped to a quarter or half (e.g. "1st Half Total") is plausibly gradable already -- ESPN's scoreboard likely exposes per-period team scores (`linescores`) on the same event object `getFinalScores` already reads in `sources/espn.ts`, just not wired up or verified live yet.
- A player stat prop scoped to a quarter/half (e.g. "1st Quarter Passing Yards") is a much bigger lift -- the free ESPN endpoint used here has no per-period player stat lines at all, so this would need a different data source entirely (play-by-play parsing, or a paid provider), not just a mapping addition.
