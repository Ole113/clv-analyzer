## Future Additions

*** There might be a better way to calculate odds at closing time.... maybe we use something like https://picktheodds.app/en/odds-screen/MLB?group=PLAYER_PROP_RUN&time=PLAYER_PROP_RUN&betGroup=PLAYER_PROP or https://4codds.com/football/nfl/props#p-6a71858e10c4a746d32aa8f2***
- Might be worth doing some testing of calculating some odds with these and some the old way with PP and see how much of a difference it makes. 
** Maybe even a plugin with these odds pages to search up players. Somethign like where you triple click on the row and it pulls a injected table of all teh lines on it from these softwares


- Add some way to use the width of a market to do some analyzing. Could even just be an "i" stat next to book line on the book snapshots


- Dry-run mode for closing reads: `POST /api/closing-snapshots?dryRun=1` returning the verdict it *would* record without writing, so a live slate can be compared against the old method before trusting the new one.
- Surface alt-line picks: a DFS pick taken at 40.5 against a 62.5 consensus produces a very large edge that is arguably correct but will distort a chart. The per-book alt lines are already recorded on each row.


Add a way to export your pikkit betting information and back test your bets. you can't find your CLV but you can find win % and some other analytical data I'm sure.
  * Per sport win %
  * Per book win %
  * Per prop type win %


Tell Claude we are about to release this app and we need a full double check of all systems components etc. Make sure it follows best practices 



Brainstorm additions to the project

- Think of analytical additions.
- Think of ways to get a more accurate EV calculation and clv calculation.
- Any additional pages to add that might be useful for my analytical analysis of my +ev betting.
- Any additional integrations to add that might be useful for my analytical analysis of my +ev betting


Add the ability to hide certain markets. There should be a way to easily add markets to the list by clicking on a bet. Should easily be able to hide/show all hidden markets.
  * Sig strikes
  * Fantasy score
  * 1q/1h receiving, rushing etc