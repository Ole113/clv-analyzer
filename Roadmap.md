## TODO

- Have analysis on graded bets as well. Can filter by which bets from which sports hit the most often, ran the best, how good the clv was for the specific sport etc. Hopefully find a free api for this. Maybe I can scrape it off of somewhere? if claude refuses the request test out one of open source models

- The checkbox for the extension should be a green when by default and should be allowed to be changed in settings.
- The spacing on the prop professor page of the prop professor check icon and the extension checkbox are too close together and the table column border runs through it. the checkbox should have its own skinny column. only 0.5px margin on the side of the checkbox
- there should be no apply button on the Analysis page. when you change an input it should automatically update the search.
- add some color to pages. an example of good color is where it shows a number that can be good or bad, such as % of bets beating clv, we make it green if it's good and red if it's bad where bad is -ev
- merge the settled/live picks pages into 1 page.
- make the overview page look nicer. i want the most important couple stats highlighted and there be a graph that you can decide to show a graph of the selected stat from the important stats
- add some information in "i" bubbles next to stats about how the stat is calculated. you can go into depth about the math behind it. if the explanation is going to get so wordy then maybe make a popup or a link to a different page depending on what will be the best for the user experience.
- add a footer with some created by information, some links, a dummy email
- remove the "CLV" table row header

## Other

1. the /bets endpoint where it shows the list of props there should be advanced searching by page like player, stat, pick, etc
1. make another page where you get advanced analysis of bets based on filters such as sport, prop type (rushing yards, passing yards, points, etc). There should also be filters on stuff like "Beat CLV" and the percentage that did. I want charts showing my best performing bets in CLV by % number should be charted the highest and show the most ev% return and the worst props that I should avoid playing in the future show how much ev was lost and which sport books were the worst ev for that specific prop bet. on the flip side also show the best performing side for the props that are +ev.
1. A way to clear out data from the last X days, weeks etc (clear the database). Make a double confirm to do so. Also let the user on the settings of a specific prop in the bet table delete that specific bet.
1. have a link to go to the odds page of odds jam and prop professor when you click on the specific row
1. A way in the settings to
1. solve this bug below where it has a failed error message on the /bets/ page
   Puka Nacua OVER 62.5
   Player Receiving Yards · Los Angeles Rams vs San Francisco 49ers · NFL · OddsJam / prizepicks · kickoff Sep 9, 1:00 AM

FAILED
The closing fetch did not complete.
Could not read the board: parseOk=false rows=0 OddsJam optimizer table not found

Queue closing read now
2 attempt(s), last Sep 8, 8:05 PM
When you took it
Sep 8, 8:00 PM
Book Line Price
FanDuel 90.5 -114
Pinnacle 90.5 -112
At market close
Sep 8, 8:05 PM
Closing lines have not been captured yet.
