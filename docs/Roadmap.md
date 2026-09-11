## Future Additions

*** There might be a better way to calculate odds at closing time.... maybe we use something like https://picktheodds.app/en/odds-screen/MLB?group=PLAYER_PROP_RUN&time=PLAYER_PROP_RUN&betGroup=PLAYER_PROP or https://4codds.com/football/nfl/props#p-6a71858e10c4a746d32aa8f2***
- Might be worth doing some testing of calculating some odds with these and some the old way with PP and see how much of a difference it makes. 
** Maybe even a plugin with these odds pages to search up players. Somethign like where you triple click on the row and it pulls a injected table of all teh lines on it from these softwares



- Dry-run mode for closing reads: `POST /api/closing-snapshots?dryRun=1` returning the verdict it *would* record without writing, so a live slate can be compared against the old method before trusting the new one.
- Surface alt-line picks: a DFS pick taken at 40.5 against a 62.5 consensus produces a very large edge that is arguably correct but will distort a chart. The per-book alt lines are already recorded on each row.


- Add a way to export your pikkit betting information and back test your bets. you can't find your CLV but you can find win % and some other analytical data I'm sure.

# Current Bugs/Additions

## In Progress

## TODO
- There should be NO checkboxes on any screen other than the fantasy screen. Currently, on PropProfessor on the odds screen there is a checkbox.
- The "At market close" books don't have their pictures next to them
- The "not averaged" text on the "When yoou took it"/"At market close" rows is not vertically aligned with the book name
- The "Queue another closing read" button needs some top padding
- Move the settings hyperlink in the navbar to the far right and make it a settings icon instead of the text.
- I've already asked you to fix this once and you didn't do it correctly. I get many errors like the ones below where the auto grading won't work. You NEED to make an exhaustive list of every possible stat market for tennis, nfl, nba, nhl, mlb, csgo, valorant, league, and any other markets that I didn't mention yet. 
Stat market "Pitcher Strikeouts" is not mapped to a box-score field yet
Stat market "Bases" is not mapped to a box-score field yet. no PropProfessor market alias for "Bases". Add it to MARKET_ALIASES.
Stat market "Tackles + Assists" is not mapped to a box-score field yet.
no PropProfessor market alias for "Player Hits + Runs + RBIs". Add it to MARKET_ALIASES.
Stat market "Player Bases" is not mapped to a box-score field yet.
no PropProfessor market alias for "Player Bases". Add it to MARKET_ALIASES.


- Implement the ability to grade 1st quarter/half stats so the error below doesn't happen. Should work for any quarter and any half. NBA also has this same market so it should work for that as well.
"1st Quarter" is a partial-game market; only full-game box scores are available, so grading it automatically would compare the wrong span.
- Explain why this would happen. The is at a consensus is around -145 but the screen says that boomfantasy and propbuilder were not averaged even though they are obviously not outliers and there no rows in the Excluded books page. It seems like you are not averaging in other fantasy books. This is not correct - even though these fantasy books aren't the sharpest we still want to average them in.
At market close:
Kalshi
6.5	-142
BetParx
6.5	-148
4cx
6.5	-151
BoomFantasy · not averaged	6.5	-149
Prop Builder · not averaged	6.5	-143
- Alt lines on prop professor do not have the same EV % as a normal fantasy play. Normal fantasy plays will show 55% but a alt line will show something like 5%. We need to assume that 0% on the alt fantasy screens means that the play is exactly 50% to hit so if you take a pick on the alt screen on PP and it says 7% this would translate to 57% EV.
- The prop professor alt line screens work like how the OJ screens work where if for example the prop is Patrick Mahomes Over 32.5 passing attemps the alt line screen on PP will say -121, -130, etc and not say 32.5 with the over under below it it will only show the other overs like how OJ does it. Use this information to correctly parse the alt screen lines so the correct lines show up in the analyzer. You make the same error when you're reading OddsJam lines and a book has the same line but with different odds you end up not averaging that because you record it as "---" even though it's the same line but just different odds. This needs to be fixed for both PP alt lines and all of OJ.
- On any pages where there are tables I want you to add the ability to click on table headers and sort the rows. For example, on the /bets page I want to be able to click on the "Kickoff" header and have it sort by soonest to be played to farthest to be played and then if you click again it reverses the order and a third click defaults and removes the sorting to the most recently added pick.
- On the /bets page I want there to be a button that says group by day and then you can group all the bets by the day. So when you click the button for each day there is a separate table that has a header above it saying somethign like "September 15th 48 picks · 41 awaiting close · 5 settled · 10 graded" where the 48 picks ... stuff is smaller text. I want this so I can see what is upcoming for the day.
- The searching for the filter dropdowns needs to be updated. It should be like how prop professor does it where when you click on the dropdown it shows you all the options but then you can also type in the players name to help you find the dropdown option quicker. The "Book" dropdown also needs to have capitalized book names.
- "Failed" as the CLV result when a bet doesn't beat CLV seems like weird wording. It would make more sense to make it "MISSED CLV" but that seems really long. Come up with a better word here. Maybe just "MISSED".
- Add the ability in settings to change the color scheme to be light or dark. Default to device settings.
- Update the odds jam link in the footer to be my afilliate link: https://oddsjam.cello.so/YYA2ODgFeaO. Do the same for prop professor: https://www.propprofessor.com/?via=jake
- Add some loading spinners for actions that may take a long time. For example, when searching with filters if there are 10,000 rows it may take a couple seconds so have a spinner for this and other actions you deem it necessary to have one for. If a button has been clicked make the spinner action inside the button replacing the button text.
- On pages where it shows bets make it so the right click has an action menu that it opens. Include some bet quick actions in the action menu such as deleting voiding, etc.
- The double checkbox bug STILL happens. It still happens when I shift+scroll on windows and it happens when i switch between PP fantasy tabs. Specifically when I go from the dabble tab to another tab. If it makes it easier you can make it so the checkbox row is Fixed and is not inside the table - I just want it fixed.


Tell Claude we are about to release this app and we need a full double check of all systems components etc. Make sure it follows best practices 



Brainstorm additions to the project

- Think of analytical additions.
- Think of ways to get a more accurate EV calculation and clv calculation.
- Any additional pages to add that might be useful for my analytical analysis of my +ev betting.
- Any additional integrations to add that might be useful for my analytical analysis of my +ev betting
