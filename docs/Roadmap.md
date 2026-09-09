## Future Additions
- Confirm that the prop professor correctly does get the clv for a prop like rushing yards where the lines may have moved
- Add in HLTV stat checking and tennis Aces
- Add a way to export your pikkit betting information and back test your bets. you can't find your CLV but you can find win % and some other analytical data I'm sure.


## Current Bugs/Additions

# In Progress
- Fix the bug when initially connecting when you test the connection it says Connected but the text is red. It should be green always when it's connected even if there are 0 picks.
- Make a contact section in the footer. Add discord username and icon in footer. Also add a mail icon and github icon with link to my github page (https://github.com/Ole113). 
- Add a couple pixels of padding on the left and right of the checkbox on the OJ and PP pages
- The "i" symbol is not vertically and horizontally centered inside the circle
- The footer should get fixed to the very bottom of the page. For example, on the bets page when there are 0 bets the footer should not be in the middle of the page since there are no bets to display - it should always be at the bottom.
- Add years to the dropdown on the "Clear picks captured in the last xyz"
- There are no checkboxes on the prop professor "Dabble" page but there are for every other prop professor fantasy book. Additionally, when I try to add a play from the dabble (Alt) page the checkbox is red and the prop doesn't get added. When there's an error adding a play there should be some indication of this and a message why. this could be a toast on the page saying what went wrong.
- Track if the prop was live or prematch. Think of the implications this means for grading/clv. Maybe we don't calculate CLV here and instead just say what the OJ/PP EV % was. Add ways to filter by live props in the different filter options.
- On the "When you took it" and "At market close" tables add the book picture on the left of the book name. Use the book pictures supplied by prop professor.
- The /bets page "i" button popup is cut off at the bottom when there is only 1 element.
- Make it so you can click on an entire row to select a bet to navigate into it instead of only being able to click the name. Only time you won't navigate into it is when you click the "odds" or "OddsJam/PropProf" links.
- When check the checkbox and then refresh the page the checkbox for the same player is now unchecked. The behavior should be that you check the checkbox for a prop and that checkbox will persist until the game starts assuming it's still on the optimizer. There should also be a way so that you can have the checkbox checked and then you can uncheck it and the play should get removed from the analyzer. Add a popup on the OJ/PP page when you uncheck it asking if you meant to do that.
- When you open up a bet it should tell you what the OddsJam/Prop professor ev % change to hit was when you took it
- OVER and UNDER do not need to be all upper case. They can just be 'Over' and 'Under'
- I want there to be a way to show the math that was used to calculate a bets EV, edge, and avg close. When a user clicks into a bet there should be another section that shows this. Have the section closed by default but can be expanded by clicking on it.
- Sometimes when you click a button nothing happens. For example, the "Queue closing read now" button when you click on it after placing a new bet does nothing. There should be advisory, warning, error messages for all buttons if a condition hasn't been met yet for them to be clicked. If a button can't be used it should be disabled and there should be a little hover message explaining why. Another example is to Add some feedback when you click "Run grader now" in the settings. Every button should have some feedback or a way for the user to know the action succeeded/failed.
- Do not use built in confirm(...). Use a custom alert popup instead. For example, marking a bet void should be a custom popup not the browser confirm dialog.
- WHen deleting picks in the settings if "0 picks would be deleted" there should be no "Delete" or "Cancel" buttons.
- Clicking on the text "CLV Analyzer" on the navbar should bring you to the overview/home page.
- On the overview page there's no reason to say "0 with no source" just ommit that if there are 0
- There are still no checkboxes on the OddsJam rebet, fliff type pages. These need to be added and need to be tracked the same way bets are for underdog, dabble etc.

# TODO

- Create an app favicon
- Make it so the "When you took it" and "At market close" book order can be adjusted in settings. Have default order (if the books are available) be FanDuel, 
- Make it so when calculated how far the line moved we can use a weighted average optionally in the settings. So we can set a weight to every book and if that book is available it's weight will be used and the rest of the books will be averaged.
- The way it checks the prop when the market closes is wrong. It's checking the existing rows instead of going to the OJ/PP sports book screen.
- On the /bets page the "i" buttons are not on the same line for Avg close, edge, and actual.
- On the Overview page the "needs attention" section should have a hyper link to the bets that need attention like the awaiting close and total pick cards.
- Fix bug:
Unknown argument `isLive`. Did you mean `site`? Available options are marked with ?.
    at <unknown> (src\app\api\closing-work\route.ts:16:32)
    at async GET (src\app\api\closing-work\route.ts:16:15)
  14 |   if (!isAuthorized(request)) return unauthorized();
  15 |
> 16 |   const due = await prisma.bet.findMany({
     |                                ^
  17 |     where: {
  18 |       status: { in: ["PENDING", "DUE", "FETCH_FAILED"] },
  19 |       isLive: false, {
  clientVersion: '6.19.3'
}

Unknown argument `marketType`. Available options are marked with ?.
    at <unknown> (src\lib\ingest.ts:175:36)
    at async ingestSnapshot (src\lib\ingest.ts:175:19)
    at async POST (src\app\api\snapshots\route.ts:32:30)
  173 |   }
  174 |
> 175 |   const created = await prisma.bet.create({
      |                                    ^
  176 |     data: { ...data, openLines: { create: openLines } },
  177 |   });
  178 |   return { bet: created, created: true }; {
  clientVersion: '6.19.3'
}
- Fix this error when adding a moneyline prop: This bet has no line to track. We should be able to track moneylines.

- Alt-line collision. matchKey deliberately excludes the line so the closing read can re-find a pick. On Alt boards offering the same player/stat/side at two different lines, ticking both would treat the second as an update of the first. Pre-existing, but the Alt fix made it reachable.
- Extension needs reloading on each browser to pick up the Batch 2 changes — chrome://extensions → reload, since extension/dist is rebuilt but Chrome caches the loaded copy.





Brainstorm additions to the project
- Think of analytical additions.
- Think of ways to get a more accurate EV calculation and clv calculation.
- Any additional pages to add that might be useful for my analytical analysis of my +ev betting.
- Any additional integrations to add that might be useful for my analytical analysis of my +ev betting