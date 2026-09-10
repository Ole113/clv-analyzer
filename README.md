# clv-analyzer

Takes a snapshot of a line when it is played and calculates the CLV automatically when the market
ends. Displays CLV statistics.

Tick a checkbox on the **OddsJam** or **PropProfessor** Fantasy Optimizer and the whole row is
snapshotted — every sportsbook line and price showing at that moment. Shortly *before* kickoff the
extension reads the same market off **PropProfessor's odds screen**, rebuilds each sportsbook's
main line, averages them, and records whether the pick beat closing line value.

## How it fits together

| Piece | What it does |
| --- | --- |
| `extension/` | Manifest V3 Chrome extension. Injects the CLV checkbox column, POSTs snapshots, and reads closing lines. |
| `server/` | Next.js app: ingest API, the schedule of what is due, and the dashboard. |
| `shared/` | Row parsers, prop matching, the market alias table, and the odds-screen reader. |

Capture and close are **different** code paths, deliberately. Capture parses a board's DOM;
the close reads a JSON endpoint. The seam between them is `ParsedRow[]`, so everything downstream
of matching is shared and identical.

Picks are captured on any machine (work laptop, home desktop) and all land in one SQLite database
on a server reached over Tailscale.

### Why the closing read happens in your browser

The capture boards sit behind Cloudflare's bot check plus a paid login, so an automated browser
cannot load them. Your own Chrome is already signed in and past that check.

The closing read needs no *scraping* — it is a plain `fetch` to a JSON endpoint — but it does need
the site's own bearer token. `POST backend.propprofessor.com/screen` requires
`Authorization: Bearer <JWT>`, and that token is not in a readable cookie and not in the NextAuth
session payload; the app holds it in memory. So:

* A tiny page-context content script (`world: "MAIN"`) **observes** the Authorization header on
  requests the site's own app already makes, and forwards it to the background worker.
* The worker caches it in `chrome.storage.session` — memory only, never written to disk — and
  attaches it to its own screen requests.
* On a 401 it refreshes once by loading the screen in a background tab, then retries. That happens
  about once per token lifetime, not once per pick, and only ever on propprofessor.com.

The bridge only ever reads a header off a request that was happening anyway. It mints nothing,
sends nothing, and stores nothing itself. If PropProfessor drops the requirement or exposes the
token somewhere readable, `token-bridge.ts` and its manifest entry can be deleted outright.

The split is:

* **The server owns the schedule.** It knows when each game starts and keeps that in SQLite, so a
  restart loses nothing. Picks handed out are *leased* for five minutes so the same pick is not
  read twice by overlapping polls.
* **The extension does the reading.** Once a minute it asks the server "anything due?", fetches
  one screen response per (league, market) — so a single read prices every pick on that market —
  and reports back.

### When the closing read happens

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

### EV method

`EV% = fair win probability x decimal payout - 1`.

The fair probability is the site's own no-vig column — OddsJam's "% CHANCE TO HIT",
PropProfessor's "Value" — because it is already de-vigged **and quoted at the exact line taken**.
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

Stay signed into OddsJam and PropProfessor in this browser — the extension reads the boards using
your existing session.

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`.
2. Open the extension's **Options** and set:
   * **Backend URL** — `http://your-mac.your-tailnet.ts.net:4319`
   * **API key** — the same value as `API_KEY` in `server/.env`
   * **Device label** — e.g. `work-laptop`, recorded with each pick
3. Hit **Test connection**. Saving prompts Chrome for permission to talk to that host.

Then open either Fantasy Optimizer and tick the purple **CLV** checkbox on any row.

* On OddsJam it is a real extra column, deliberately separate from OddsJam's own "TRACK" checkbox
  (which opens their bet-slip builder — this extension never touches it).
* On PropProfessor the grid is AG Grid, so the checkbox rides inside the existing actions cell.

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
* `/settings` — database size, a two-step "clear the last N days" purge, and the current closing
  configuration.
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

Markets live in `shared/src/markets.ts`. The names PropProfessor accepts are in
`shared/src/__fixtures__/pp-screen-vocabulary.json` (extracted from its page bundle — there is no
endpoint that lists them). Use the `value`, not the `label`: they differ occasionally, e.g.
"Player Pass + Rush + Rec Touchdowns" is sent as "Player Passing + Rushing + Receiving Touchdowns".

## Testing

```bash
npm test --workspace server              # CLV maths, book classification, matching
npx tsx src/scripts/seed-demo.ts         # populate the dashboard with demo picks
npx tsx src/scripts/seed-demo.ts --clear # remove them
```

To exercise the full pipeline without waiting for a real kickoff, capture any pick and press
**Queue closing read now** on its detail page. The next time the extension polls (within a
minute) it will read the screen and fill in the verdict.

The closing path has fixture tests that need no browser at all — `pp-screen-source.test.ts` runs
saved screen responses through normalization, matching and the verdict builder, including two of
the real picks in the database.

## Maintenance notes

The capture boards are third-party UIs that will change. The parsers are structural (they key off
header text, `img alt` book names, and AG Grid's `col-id`/`row-id`) rather than styling classes, so
they tolerate cosmetic churn — but a real redesign will need
`shared/src/parsers/{oddsjam,propprofessor}.ts` revisited. Both were verified against the live
boards in September 2026.

The closing path depends on an undocumented endpoint (`POST backend.propprofessor.com/screen`) whose
shape could change without notice. The fixtures under `shared/src/__fixtures__/` pin the shape that
was observed, so a break shows up as a failing test rather than as silently wrong CLV. Two real
traps are encoded there and should not be "simplified" away: a selection key of `"null"` can still
carry a real line (recorded only in the selection text), and `line1`/`line2` are equal on props but
deliberately opposite on spreads.

### Comparing old and new verdicts

The screen shows more books than the optimizer did, so the closing average for the same pick is not
the same number under both methods. Every verdict records `closingSourceSite`; rows measured the old
way are stamped `OPTIMIZER_LEGACY`. Do not mix the two in a historical beat-rate without saying so.

If picks start piling up as `FETCH_FAILED`, check the obvious things first: is Chrome running and
still signed into both sites, and can it load the board manually without a Cloudflare challenge?
