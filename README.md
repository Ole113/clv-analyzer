# clv-analyzer

Takes a snapshot of a line when it is played and calculates the CLV automatically when the market
ends. Displays CLV statistics.

Tick a checkbox on the **OddsJam** or **PropProfessor** Fantasy Optimizer and the whole row is
snapshotted — every sportsbook line and price showing at that moment. A couple of minutes after
kickoff the server re-opens that board on its own, reads the same prop's closing lines, averages
the real sportsbooks, and records whether the pick beat closing line value.

## How it fits together

| Piece | What it does |
| --- | --- |
| `extension/` | Manifest V3 Chrome extension. Injects the CLV checkbox column and POSTs snapshots. |
| `server/` | Next.js app: ingest API, the schedule of what is due, and the dashboard. |
| `shared/` | The row parsers and prop matching. The **same** code runs at capture time and at close time, so both reads of the board are identical. |

Picks are captured on any machine (work laptop, home desktop) and all land in one SQLite database
on the always-on Mac, reached over Tailscale.

### Why the closing read happens in your browser

Both sites sit behind Cloudflare's bot check plus a paid login, so an automated browser cannot
load these boards — it gets stuck on "Verify you are human". Your own Chrome is already signed in
and has already cleared that check, so that is where the reading happens.

The split is:

* **The server owns the schedule.** It knows a 5:30 game is due at 5:32 and keeps that in SQLite,
  so a restart loses nothing.
* **The extension does the reading.** Once a minute it asks the server "anything due?", and if so
  opens the board in a background tab, reads the same prop's current lines, and reports back.

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
Sleeper, ParlayPlay…) and derived columns (OddsJam's "Algo Odds") are stored and displayed but
excluded — their number is a fixed-payout threshold, not a market price. Edit
`shared/src/books.ts` to change that.

If no sportsbook is still quoting the prop at close, the pick is marked **UNAVAILABLE** rather
than scored against a guess.

## Setup

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
| `DUE` | Queued, waiting for a browser with the extension to read the board. |
| `CLOSED` | Closing lines captured, verdict recorded. |
| `UNAVAILABLE` | Ran, but no sportsbook was still quoting the prop. Not counted as a loss. |
| `FETCH_FAILED` | The board could not be read (signed out, Cloudflare challenge, layout change). Retried, then left for you. |

## Testing

```bash
npm test --workspace server              # CLV maths, book classification, matching
npx tsx src/scripts/seed-demo.ts         # populate the dashboard with demo picks
npx tsx src/scripts/seed-demo.ts --clear # remove them
```

To exercise the full pipeline without waiting for a real kickoff, capture any pick and press
**Queue closing read now** on its detail page. The next time the extension polls (within a
minute) it will open the board, read the prop, and fill in the verdict.

## Maintenance notes

Both sites are third-party UIs that will change. The parsers are structural (they key off header
text, `img alt` book names, and AG Grid's `col-id`/`row-id`) rather than off styling classes, so
they tolerate cosmetic churn — but a real redesign will need
`shared/src/parsers/{oddsjam,propprofessor}.ts` revisited. Both were verified against the live
boards in September 2026.

If picks start piling up as `FETCH_FAILED`, check the obvious things first: is Chrome running and
still signed into both sites, and can it load the board manually without a Cloudflare challenge?
