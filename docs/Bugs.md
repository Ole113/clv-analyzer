# Reported Bugs

# New

- The "Settings" text on the sidebar in the settings gets hidden when you scroll down the settings page.
- Light failed
- Invalid `__TURBOPACK__imported__module__$5b$project$5d2f$server$2f$src$2f$lib$2f$prisma$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].appSettings.upsert()` invocation in /Users/alex/Documents/Programming/clv-analyzer/server/.next/server/chunks/ssr/[root-of-the-server]**6b75ce9d.\_.js:2148:160 2145 }; 2146 } 2147 async function saveThemePreference(themePreference) { → 2148 await **TURBOPACK**imported**module**$5b$project$5d2f$server$2f$src$2f$lib$2f$prisma$2e$ts**$5b$app$2d$rsc$5d$**$28$ecmascript$29$**["prisma"].appSettings.upsert({ where: { id: "singleton" }, update: { themePreference: "light" }, create: { id: "singleton", bookOrder: "fanduel,draftkings,betmgm,caesars,pinnacle,betonline,bovada,fliff,rebet,betrivers,espnbet,fanatics,hardrock,ballybet,betparx,bet105,novig,prophet,circa,kalshi,polymarket,pointsbet,wynnbet,superbook,4cx,thescore,sportzino,onyx", themePreference: "light", ~~~~~~~~~~~~~~~ ? useWeightedAverage?: Boolean, ? bookWeightsJson?: String, ? useLiquidityWeighting?: Boolean, ? updatedAt?: DateTime } }) Unknown argument `themePreference`. Available options are marked with ?.

## To Test Completion:

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
  6.5 -142
  BetParx
  6.5 -148
  4cx
  6.5 -151
  BoomFantasy · not averaged 6.5 -149
  Prop Builder · not averaged 6.5 -143
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
- There is a major bug in the way you pull the book lines. On prop professor (with the exception of alt screens) when looking at a line a book has on something it will always show the prop line (like 32.5 passing attempts) and then below it it will have the american odds. If the prop if for an under it will always be under/over. for example -116/+118 where -116 is the under and if the prop was an over it would've been +118/-116. You always want to take whatever is on the left because that's what the prop is for.
