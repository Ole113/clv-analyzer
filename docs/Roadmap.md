## Future Additions

- ~~Confirm that the prop professor correctly does get the clv for a prop like rushing yards where the lines may have moved~~ **Done.** Closing lines now come from PropProfessor's odds screen instead of the edge-filtered optimizer, so a prop whose line has moved is still priced. Pinned by a fixture test against two real stored picks (Xavier Robinson rushing yards, Johnathan Montague receiving yards).
- Add in HLTV stat checking and tennis Aces — tennis Aces is now *priceable* (`Player Aces`, real sportsbooks quote it on the screen); grading it is still open. PropProfessor's league list includes CSGO, COD, LoL and Valorant, which may cover the HLTV side.
- Dry-run mode for closing reads: `POST /api/closing-snapshots?dryRun=1` returning the verdict it *would* record without writing, so a live slate can be compared against the old method before trusting the new one.
- Surface alt-line picks: a DFS pick taken at 40.5 against a 62.5 consensus produces a very large edge that is arguably correct but will distort a chart. The per-book alt lines are already recorded on each row.
- Add a way to export your pikkit betting information and back test your bets. you can't find your CLV but you can find win % and some other analytical data I'm sure.

## Current Bugs/Additions

# In Progress

# TODO

Brainstorm additions to the project

- Think of analytical additions.
- Think of ways to get a more accurate EV calculation and clv calculation.
- Any additional pages to add that might be useful for my analytical analysis of my +ev betting.
- Any additional integrations to add that might be useful for my analytical analysis of my +ev betting
