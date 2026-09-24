# clv-analyzer

Takes a snapshot of a line when it is played and calculates the CLV automatically when the market
ends. Displays CLV statistics.

Tick a checkbox on the **OddsJam** Fantasy Optimizer and the whole row is snapshotted — every
sportsbook line and price showing at that moment. The **odds button** beside it answers "what is
this market priced at right now" from a real sportsbook market, rebuilding each book's main line
and averaging them the same way a closing read does.

> **Nothing in this project reads PropProfessor.** That account was banned for automated access in
> September 2026; every module that could make such a request — the token bridge, the closing
> reader and worker, the server-side screen reader, the board content scripts — has been deleted,
> and a test fails the build if the hostname reappears in code. Scheduled closing-line capture is
> **paused** as a result; the numbers the odds button shows are live reads, not stored closes.

## How it fits together

| Piece | What it does |
| --- | --- |
| `extension/` | Manifest V3 Chrome extension. Injects the CLV checkbox column, POSTs snapshots, and reads Odds Terminal on your own signed-in session when you click the odds button. |
| `server/` | Next.js app: ingest API, the schedule of what is due, the verdict arithmetic, and the dashboard. |
| `shared/` | Row parsers, prop matching, the market vocabulary, and the read planners (which name no host, by test). |

### The two datasets

The dashboard analyses two histories that never mix, chosen with the source switch at the top of
**Analysis** and **Picks**:

* **Captured picks** — everything the extension ticks. Measured against the closing line: beat-CLV
  rate, edge, EV%. It knows what the market did and nothing about money, because a captured pick
  has no stake.
* **Pikkit history** — a `transactions.csv` exported from Pikkit and imported on the Analysis page.
  Measured in money: ROI, profit, win rate, by book, league, market, price, stake, day and hour.
  The exact mirror image — it knows what was risked and returned, and for most books nothing about
  the close.

They are separate tables (`PikkitBet` / `PikkitLeg`) and a separate engine
(`server/src/lib/pikkit/`) because they share no metric at all. Imports upsert on Pikkit's own bet
id, so exports can be dropped in year after year and a bet that was open last time simply settles.
A Pikkit export settles the whole slip and never its legs, so leg-level breakdowns are *exposure*
("slips containing a receiving-yards leg returned this"), never a per-leg hit rate, and the page
says so where it matters.

Capture and close are **different** code paths, deliberately. Capture parses a board's DOM;
the close reads a JSON endpoint. The seam between them is `ParsedRow[]`, so everything downstream
of matching is shared and identical.

Picks are captured on any machine (work laptop, home desktop) and all land in one SQLite database
on a server reached over Tailscale.

### Why a market read happens in your browser

The capture board sits behind Cloudflare's bot check plus a paid login, so an automated browser
cannot load it. Your own Chrome is already signed in and past that check. The same is true of
**Odds Terminal**, which is where the odds button now reads from.

What changed in September 2026, and why it matters more than the plumbing: the previous version of
this read used a **captured bearer token** to let the *server* make requests to PropProfessor on a
timer, whether or not anyone was looking. That is what got the account banned. The arrangement now
is deliberately the opposite, and the properties are structural rather than a matter of care:

* **The extension does the fetching, in its background worker.** Chrome attaches the session cookie
  because the extension declares a host permission for that site; the code never sees, stores or
  forwards a credential of any kind. There is no token bridge and nothing in `chrome.storage`.
* **A read happens because you clicked.** There is no alarm, no interval and no queue on that path.
  `odds-terminal-read.ts` is the only file in the repository that knows the hostname, and the guard
  test fails if it grows a timer.
* **The server never contacts the site.** It plans the read (which books, which market names —
  both come from your own settings and this project's vocabulary) and computes the verdict from the
  entries the extension hands back. It cannot originate contact, because it is never told where.
* **No tab is opened.** An earlier attempt did open one, on every click; that is gone.

### When the closing read happens *(paused)*

Closing-line capture is not running: it read PropProfessor, and that is gone. The schedule below is
what the server still computes and what the feature will use if it is ever pointed at another
source, so it is documented rather than deleted. Picks captured now keep their open snapshot and
simply have no close recorded.

A **window before kickoff**, not a single shot after it:

| Setting | Default | Meaning |
| --- | --- | --- |
| `CLOSING_READ_OPENS_MINUTES_BEFORE` | 8 | Window opens at T−8. |
| `CLOSING_READ_TARGET_MINUTES_BEFORE` | 3 | Where the read ideally lands. |
| `CLOSING_READ_CLOSES_MINUTES_AFTER` | 5 | Kept slightly past kickoff so a read in flight can land. |

This is not a preference. A game that has started is **no longer listed on the odds screen at
all**, so the old "kickoff + 2 minutes" schedule would have found nothing 100% of the time. Serving
a window also means a failed read at T−8 simply retries at T−7 rather than burning the pick's only
chance.

The trade-off, stated plainly: reading at T−3 misses the last three minutes of steam, where late
scratch news lands. That biases measured CLV slightly *downward* on exactly the picks that moved
hardest. Reading after kickoff risks measuring nothing at all — a small known bias beats a large
unknown one.

Because reads are pre-kickoff, `closingCaptureLagSeconds` is normally **negative**. That is the
healthy case. Large positive values still mean the browser was not running at kickoff, and are
flagged as late.

**This means Chrome needs to be running near kickoff.** The natural home for that is the
always-on Mac: install Chrome there, sign into both sites, load the extension, and it becomes the
capture agent — the same machine that already runs the server. Any other browser with the
extension installed will also pick up due work, so a laptop that happens to be open contributes
too.

If nothing is running at kickoff the pick simply stays queued and is read whenever a browser next
comes online — and that read is **flagged as late** (`STALE_CAPTURE_MINUTES`, default 20) rather
than being passed off as a genuine closing line.

### The Odds modal, and the two sources behind it

The dashboard is the wrong place to ask "what is this market really priced at": by the time a pick
is on `/bets` it has already been taken. So the same modal is injected on the board — a small
button stacked **above** the CLV checkbox on each OddsJam row — and it opens with two tabs.

**Odds Terminal** (the default tab) is read by the extension's background worker, on the Odds
Terminal session your own browser already holds. A lookup is two plain JSON requests:

1. **the slate** — `/api/snapshot?sport=…&league=…&start_date_after=…&start_date_before=…`, which
   is how the pick's game is found. Three details there are load-bearing, each learned the hard way:
   the endpoint answers for the **next 36 hours** unless those two date parameters widen it (so a
   Sunday NFL game is invisible on a Wednesday); the slate is **paginated at 100** (a seven-day
   college football slate is 121 games); and when the board recorded a kickoff time the window
   narrows to the hours around it instead.
2. **that fixture's odds** — the same endpoint *with* `fixture_id`, which is the difference between
   "three main markets" and **every market the game has**, player props included: 112 markets and
   3,600-odd quotes on one NFL game with five books attached.

Markets are matched by **name**, never by id: the feed slugs its own display names, punctuation and
all (`player_hits_+_runs_+_rbis`), so any table of ids is wrong more often than right. A pick's
board spelling, this project's canonical name for it and the period-prefixed form the feed uses are
all accepted — see `oddsTerminalMarketKeys`.

Five books per request is the endpoint's hard ceiling, so the books are ranked by your own book
order and asked for in chunks of five; if fewer than three of them quote the market, the next five
are asked and the answers merged. That is not theoretical: on one NFL game DraftKings quoted 20
player markets and FanDuel 13, while Pinnacle, BetOnline and Circa — all ranked higher in this
install — quoted none at all.

**The Odds API** is the second tab, lazily loaded: a keyed, metered third-party API the server calls
directly, unrelated to any board. One credit per read, with the remaining quota shown in the footer.

Both tabs are answered by `buildClosingVerdict` on the server, never by the content script. The
averaging, the sportsbook allowlist and the outlier test live there, and a second implementation in
the extension would drift from it silently — leaving the board modal and the dashboard modal quoting
different closing numbers for the same market with no way to tell which was right.

Whichever board asked, the read never goes back to that board. An OddsJam row looking up its own
market sends OddsJam nothing; the capture site is provenance and has no influence on where the read
goes, which is asserted by `oddsjam-automation-guard.test.ts`.

### Line is not the whole story: the average price

A market can move hard without its line moving at all. A passing-touchdowns prop sits on 2.5 all
week — there is no 2.6 for it to drift to — so the line average reads 2.50 and the edge reads 0.00
while the price behind that same 2.5 travels from -110 to -145. Both modals therefore show an
**average price** next to the average line.

Two things about how it is computed:

* **Averaged as probabilities, never as American odds.** American odds are a display format, not a
  scale: they are discontinuous across ±100 and wildly non-linear. Averaging -110 and +110
  numerically gives 0, which is not a price; averaging their implied probabilities gives 0.5, which
  converts back to +100. This is the same reasoning `findLineOutliers` already applies to
  moneylines.
* **Vigged on purpose.** The question is "what is this priced at", not "what is the true
  probability". The de-vigged answer to the second is `closeFairProb`, computed separately;
  conflating them would show a price better than anything anyone could actually bet.

It is taken over exactly the books that feed the line average, so the two can never describe
different fields — the book counts are shown separately because they legitimately differ (a book is
kept in the line average whenever it quotes the market, including on one side only, but it can only
contribute a price for the side actually taken).

### EV method

`EV% = fair win probability x decimal payout - 1`.

The fair probability is the board's own no-vig column — OddsJam's "% CHANCE TO HIT" — because it
is already de-vigged **and quoted at the exact line taken**.
It cannot be derived from the raw book cells: the boards show one price per book at that book's
own line, so there is no opposing side to de-vig against and no way to re-price a 62.5 pick from
a book hanging 90.5. The payout comes from the DFS column when the board shows one, else
`DEFAULT_PICKEM_PRICE`.

Picks captured before this was added carry no EV%; the analysis page says so rather than
averaging around them.

### CLV method

Line-number-only, per book consensus:

* **Over** beats the close when the average closing line is **higher** than the line you took.
* **Under** beats the close when it is **lower**.
* A perfectly flat line does **not** count as beating the close.

Only real sportsbooks quoting a line feed the average. Pick'em apps (PrizePicks, Underdog, Betr,
Sleeper, ParlayPlay…) and derived columns are stored and displayed but excluded — their number is a
fixed-payout threshold, not a market price. Edit `shared/src/books.ts` to change that.

The screen path uses an **allowlist** (`isSportsbookForClose`) where the capture path uses a
denylist. On an optimizer, DFS and algo columns are price-only, so the "has a line?" test filtered
them out whatever they were called. On an odds screen essentially every column carries a line, so a
denylist admits anything it has not been told about yet — including whatever derived column the site
adds next. The allowlist fails the other way: a genuine new book is left out until named, which is
visible and fixable, rather than silently averaged in.

Sweepstakes books (Fliff, Rebet, SportZino, OnyxOdds) **are** counted. They quote a real two-sided
market rather than a fixed-payout pick threshold, which is the line that actually matters here.

One caveat worth knowing: some books mirror each other's prices exactly. In the captured data
OnyxOdds' entire ladder is identical to DraftKings', and BetRivers / BallyBet / BetParx are
identical to one another (all Kambi skins). A plain mean therefore counts a shared opinion more than
once. That is pre-existing rather than new, and the per-book weights in `/settings` are the lever if
you want to correct for it.

#### Rebuilding each book's main line

The optimizer showed every book's line side by side in one row. The screen instead splits a market
into one *selection* per line, with a different set of books under each — passing yards might list
60, 62 and 65 separately. Reading any single selection therefore sees only a fraction of the field.

So each book's own main line is reconstructed across all selections: the selection where that
book's price is **least lopsided**, because that is what separates a real market from an alt (a
book hanging Over 9.5 at −400 is not quoting 9.5, it is selling a near-certainty). Those
per-book lines are then averaged, which keeps `edge` in line units and leaves every direction
convention untouched. Alt lines a book also quoted are recorded on the row rather than discarded.

A book is kept whenever it quotes the market at all, even if the side you took has no price: the
line belongs to the market, not to one side of it. In the captured Xavier Robinson market only 10
of 18 books price the Under, and demanding one would drop DraftKings, Fanatics and theScore.

#### Discounting outliers

Two separate defences, because bad quotes arrive in two different shapes.

**A price nobody would take.** If a book's best selection is still priced outside roughly ±400
(20–80% implied), it is not a line anyone is really offering — typically one resting order on an
exchange. Its *line* often looks perfectly ordinary, so a consensus check would never catch it; the
giveaway is the price. Dropped before averaging. Never applied to moneylines, where −1000 is an
ordinary price for a heavy favourite.

**A line far from the field.** Books whose reconstructed line sits outside a median-absolute-
deviation band around the consensus are excluded and named in the verdict note. Feeds go stale: in
the captured Robinson market, Fanatics' entire ladder is offset from everyone else's, and averaging
it in moves the close from 22.6 to 25.9 — cutting the measured edge by more than half.

Two details matter in that second test:

* **Moneylines are compared as probabilities, not American odds.** For a moneyline the tracked line
  *is* the price, and American odds are a terrible scale for arithmetic — discontinuous at ±100 and
  wildly non-linear. −105 and +105 are nearly the same bet but sit 210 apart; −1000 and −5000 are
  4000 apart and differ by four points of probability. Comparing implied probability is the only way
  −1000 against a field of −150 reads as an outlier without also flagging every book near pick'em.
* **Exchanges don't define the consensus.** On Novig, Prophet X, Kalshi and Polymarket the price is
  whatever order is resting, so several being off-market at once is not evidence the market moved.
  They are excluded from the reference median whenever at least three traditional books remain, and
  are then held to a tolerance twice as tight. A rejected exchange never drags the sportsbooks out
  with it.

The band needs at least three books to act at all, and it will never reject half or more of the
traditional books — if it would, the field has no consensus and everything is kept.

If the market is listed but the selection is gone, the pick is **UNAVAILABLE**. If no book prices
that market at all, it is **NO_CLOSING_MARKET**. Neither is scored against a guess.

## Setup

### 0. Before you start

Everything below assumes these are already installed. If you have never set up a Node.js project
before, install them in this order:

| Dependency | What it's for | Install |
| --- | --- | --- |
| **Git** | Downloads ("clones") this repository to your computer. | [git-scm.com/downloads](https://git-scm.com/downloads) — macOS/Windows installers, with a plain-language walkthrough. |
| **Node.js** (v20 or later) | Runs the server and the build scripts. **npm comes bundled with it** — installing Node.js is all you need for both. | [nodejs.org](https://nodejs.org/) — download the **LTS** version for your OS. [Official install guide](https://nodejs.org/en/download) if the installer needs more explanation. |
| **Google Chrome** | Runs the browser extension that captures picks and reads closing lines. | [google.com/chrome](https://www.google.com/chrome/) |

After installing, confirm they worked by opening a terminal (macOS: Terminal app; Windows:
PowerShell) and running:

```bash
git --version
node --version   # should print v20 or higher
npm --version    # installed automatically with Node.js
```

If any of those print "command not found", close and reopen the terminal (installers sometimes
need a fresh shell to be found) before trying again.

Then clone the repository itself:

```bash
git clone https://github.com/Ole113/clv-analyzer.git
cd clv-analyzer
```

### 1. Install and build

On the machine that hosts the server and database:

```bash
npm install
npm run build
```

On a machine that only captures picks — a Windows or Mac laptop running just the extension —
build the extension alone. It needs neither the Next.js build nor the Prisma client:

```bash
npm install
npm run build:extension    # writes extension/dist
```

`extension/dist` is generated, not committed, so **it does not exist until you build**. Chrome
reporting a missing or unreadable manifest on "Load unpacked" means the build has not run (or did
not finish) on that machine.

Windows works for everything except the launchd agent in step 3, which is macOS-only.

### 2. Configure the server

```bash
cd server
cp .env.example .env      # then set API_KEY to a long random value:  openssl rand -hex 24
npm run db:push           # creates prisma/clv.db
```

On Windows PowerShell the first two are `copy .env.example .env` and
`-join ((1..24) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })`.

Settings in `.env`:

| Key | Meaning |
| --- | --- |
| `API_KEY` | Shared secret the extension sends. |
| `CLOSING_BUFFER_MINUTES` | Minutes after kickoff before the closing line is read (default 2). |
| `MAX_FETCH_ATTEMPTS` | Retries before a pick is left as `FETCH_FAILED`. |
| `STALE_CAPTURE_MINUTES` | A closing read later than this after kickoff is flagged as late. |

### 3. Run it

```bash
npm run dev --workspace server     # http://localhost:4319
```

For the always-on Mac, install the launchd agent so it survives reboots — see the instructions in
`server/deploy/com.clvanalyzer.server.plist`. That file is macOS-only and is the one place in the
repo with hardcoded paths (`$HOME/Documents/Programming/clv-analyzer`, `/tmp/clv-analyzer.log`);
edit them if the repo lives elsewhere. To host the server on Windows instead, run
`npm run start --workspace server` and keep it alive with Task Scheduler ("At startup", "Run
whether user is logged on or not") or NSSM — nothing else about the server is Mac-specific.

### 4. Tailscale (so both computers reach it)

Install Tailscale on the Mac **and** on the work and home computers, sign them into the same
tailnet, then note the Mac's MagicDNS name. The backend never needs to be exposed to the public
internet and no ports need forwarding.

### 5. Load the extension (on each computer)

Stay signed into OddsJam in this browser — the extension reads the board using your existing
session — and into **Odds Terminal**, which is what the odds button reads. Nothing signs in for
you, and nothing stores a password or a token: Chrome attaches those sessions itself because the
extension declares a host permission for each site.

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`.
2. Open the extension's **Options** and set:
   * **Backend URL** — `http://your-mac.your-tailnet.ts.net:4319`
   * **API key** — the same value as `API_KEY` in `server/.env`
   * **Device label** — e.g. `work-laptop`, recorded with each pick
3. Hit **Test connection**. Saving prompts Chrome for permission to talk to that host.

Then open the OddsJam Fantasy Optimizer and tick the purple **CLV** checkbox on any row. It is a
real extra column, deliberately separate from OddsJam's own "TRACK" checkbox (which opens their
bet-slip builder — this extension never touches it).

The small chart icon above each checkbox opens the odds modal. The first click on a market takes a
second or two (two requests to Odds Terminal, one to your server); if it reports that you are
signed out, open <https://oddsterminal.org> in that browser, sign in, and hit Refresh in the modal.

The checkbox turns **green** when the server has the pick, **amber** if it was queued because the
server was unreachable (it retries automatically), and **red** on a real error — hover for why.

## Dashboard

* `/` — beat rate, average edge, sample size, plus counts of anything needing attention, and
  breakdowns by sport, site, book and stat.
* `/bets` — live/pending vs settled, with free-text search (player, stat, team, matchup) and
  filters for sport, stat, side, book, site, result and date range. Every row links out to the
  board it came from.
* `/analysis` — the same filters over settled picks, plus: best and worst prop types by EV%
  against the close, how much EV each losing prop gave up, which sportsbook hung the least
  favourable closing number per prop, and an Over vs Under split.
* `/kelly` — how much to stake on a line that is off the market. Enter the price you are getting
  and how many odds points it beats fair by (Fliff -110 against a -140 market is 30) and it gives
  the EV, the Kelly fraction and the dollars. The same calculator is on a **Kelly** button inside
  OddsJam's own "Add to Bet Tracker" modal, on the boards that quote real prices.
* `/settings` — database size, a two-step "clear the last N days" purge, the current closing
  configuration, and the Kelly bankroll, multiplier and board list. The bankroll lives here rather
  than in the extension so it is one number, whichever browser is asking.
* `/bets/<id>` — the board as it looked when you took the pick, side by side with the board at
  close, the verdict, and a **Force closing fetch now** button.

## Pick statuses

| Status | Meaning |
| --- | --- |
| `PENDING` | Waiting for kickoff. |
| `NEEDS_GAME_TIME` | Captured with no kickoff time; set one on the detail page to schedule it. |
| `DUE` | Queued and leased, waiting for a browser with the extension to read it. |
| `CLOSED` | Closing lines captured, verdict recorded. |
| `UNAVAILABLE` | The market was listed at close but this selection was not in it — a scratch or a pulled prop. Terminal, not counted as a loss, and does **not** burn a retry. |
| `NO_CLOSING_MARKET` | No sportsbook prices this market at all (DFS-only composites like "Fantasy Score", period-qualified props). A fact about the market, not a failure. Decided from the alias table before any read is attempted. |
| `FETCH_FAILED` | The read genuinely broke, **or** we have no alias for this market yet. Retried, then left for you. |

`UNAVAILABLE` and `NO_CLOSING_MARKET` are split on purpose. Folding "can never be closed" into
"was not found" is precisely the collapse that hid the original bug, and it also kept unpriceable
picks burning fetch attempts forever.

## Adding a market

The alias table is the one permanent maintenance cost of this design, and it is deliberately loud:
an unmapped market becomes `FETCH_FAILED` with a message naming it, never a quiet `UNAVAILABLE`.

Markets live in `shared/src/markets.ts`. That table is this project's canonical vocabulary: a
board's spelling on the left, the full "Player X" name on the right. Odds Terminal happens to spell
its markets the same way, so adding a line there is usually all a new market needs —
`oddsTerminalMarketKeys` resolves a pick through it and matches the feed by name.

`odds-terminal-source.test.ts` carries the list of markets this install has actually captured,
checked against names read off live fixture responses; add a row there when a new spelling reaches
the database, and a market that stops resolving fails the build instead of showing an empty modal.

## Testing

```bash
npm test --workspace server              # CLV maths, book classification, matching
npx tsx src/scripts/seed-demo.ts         # populate the dashboard with demo picks
npx tsx src/scripts/seed-demo.ts --clear # remove them
```

The odds path has fixture tests that need no browser at all: `odds-terminal-odds.test.ts` runs a
real captured fixture response (`shared/src/__fixtures__/odds-terminal-nfl-fixture.json` — five
books, a full alt ladder, an exchange with real depth) through normalization, matching and the
verdict builder, and `odds-terminal-source.test.ts` pins the request shape the live endpoint
actually requires.

## Maintenance notes

The capture boards are third-party UIs that will change. The parsers are structural (they key off
header text, `img alt` book names, and AG Grid's `col-id`/`row-id`) rather than styling classes, so
they tolerate cosmetic churn — but a real redesign will need `shared/src/parsers/oddsjam.ts`
revisited. It was verified against the live board in September 2026.

The odds path depends on an undocumented endpoint (`GET oddsterminal.org/api/snapshot`) whose shape
could change without notice. The fixture under `shared/src/__fixtures__/` pins the shape that was
observed, so a break shows up as a failing test rather than as silently wrong numbers. Three traps
are encoded there and should not be "simplified" away: a game total arrives with an **empty
`selection`** (it names no player and no team), a spread's two sides carry **opposite-signed
points** and must be paired on magnitude, and `is_main` is the feed's own word on which of a book's
nine alt lines is the market.

### Comparing old and new verdicts

The screen shows more books than the optimizer did, so the closing average for the same pick is not
the same number under both methods. Every verdict records `closingSourceSite`; rows measured the old
way are stamped `OPTIMIZER_LEGACY`. Do not mix the two in a historical beat-rate without saying so.

If picks start piling up as `FETCH_FAILED`, check the obvious things first: is Chrome running and
still signed into both sites, and can it load the board manually without a Cloudflare challenge?
