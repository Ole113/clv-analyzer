# Pre-release review

A full pass over the server, the extension and the shared package, written while fixing the Odds
modal. Ordered by what would hurt most on a public release, not by where it lives in the tree.

Items marked **FIXED** were fixed in this same pass and are listed so the reasoning is on record;
everything else is open and is a decision, not an oversight to be quietly patched.

---

## 1. Blocking: the dashboard has no authentication at all

**Severity: blocking for anything past Tailscale.**

`isAuthorized` (`server/src/lib/auth.ts`) guards `/api/*` with a shared secret. Nothing guards:

- every page — `/`, `/bets`, `/bets/[id]`, `/analysis`, `/settings`, `/exclusions`
- **every Server Action**, which is the real problem

Server Actions are POST endpoints with IDs baked into the client bundle, and their arguments come
from the client. Anyone who can load the app can invoke:

| Action | File | Effect |
| --- | --- | --- |
| `purgeRecent` | `app/settings/page.tsx` | Deletes every pick captured in a window — pass `(9999, "years", false)` and the database is empty |
| `purgeDemo` | `app/settings/page.tsx` | Deletes all test data |
| `deleteBetQuick` | `lib/bet-actions.ts` | Deletes one pick and its snapshots |
| `voidBetQuick` | `lib/bet-actions.ts` | Rewrites a grade |
| `generateTestDataAction` | `app/settings/page.tsx` | Writes up to 500 fake picks into the real sample |
| `requestOddsPreview` | `lib/bet-actions.ts` | Now makes the server send an authenticated request to PropProfessor |

Next's own CSRF check (Origin vs Host) stops a *cross-site* invocation, so this is not "any website
can wipe your database". It is "anyone who can reach the port can", and the process is deliberately
reachable from every device on the tailnet.

This is fine, and was always fine, for a single-user tool behind Tailscale. It is not fine for a
public release, and no amount of tidying elsewhere substitutes for it.

**Recommended fix**, roughly in order of effort:

1. `middleware.ts` matching everything except `/api/health`, checking a signed session cookie set by
   a single password login. ~40 lines, no dependency, and it covers Server Actions because they run
   through the middleware too.
2. Or keep it Tailscale-only and make that explicit — bind to the tailnet interface rather than
   `0.0.0.0`, and say so in the README's Setup section instead of leaving it implied.

Do not ship a public build on option 2 without the bind change: `next start -p 4319` listens on all
interfaces, so a coffee-shop Wi-Fi is enough.

## 2. Aggregates silently truncate at a row cap

**Severity: high — the numbers quietly stop being true rather than failing.**

`getOverviewStats` (`take: 5000`), `getFacets` (`take: 5000`), `getTimeSeries` (`take: 5000`) and
`getExclusionAudit` (`take: 3000`) all load rows into JS and reduce them there. Past the cap the
page keeps rendering and the beat-rate, hit-rate and cumulative-edge numbers are computed over an
arbitrary subset — with nothing on screen saying so.

At a few hundred picks this is invisible. At a few thousand — one season of volume, plus a couple of
500-pick test-data loads — it starts lying, and the failure mode is a number that looks plausible.

**Fix:** either push the aggregation into SQL (`groupBy` / `_avg` / `_count`, which Prisma already
supports and `settings/page.tsx` already uses for `gradeCounts`), or keep the cap and render a
banner when `bets.length === cap`. The second is ten minutes' work and removes the "quietly wrong"
property, which is the part that matters.

## 3. The in-memory preview state does not survive a restart — by design, now bounded

**Severity: low. FIXED (the leak half).**

`lib/odds-preview.ts` keeps pending requests and results in `globalThis` maps, and `lib/pp-token.ts`
keeps the PropProfessor token the same way. That is deliberate and documented: a credential should
not be written to disk, and a preview is disposable.

What was not deliberate: nothing ever removed a result. Every Odds click added a full
`ClosingVerdict` — every book line of it — to a map that lived as long as the process. **FIXED:**
`rememberResult` now bounds it at 200 entries, evicting oldest-first.

The restart behaviour is still worth knowing, though it is now largely covered: `ensureServerToken`
pushes the token back on the closing alarm, on browser startup, and the moment the dashboard is
opened (a runtime-registered content script on the backend's own origin). What remains is the case
where PropProfessor itself cannot be signed into, which no amount of warming can fix and which the
modal now says plainly.

## 4. Query-string input could 500 a page

**Severity: medium. FIXED.**

`parseBetFilters` fed unvalidated query-string values straight to Prisma:

- `?limit=abc` → `Number("abc")` is `NaN` → `take: NaN` → Prisma validation error → the whole
  `/bets` page 500s.
- `?from=yesterday` → `new Date(...)` is an Invalid Date, not an exception → same outcome.
- `?status=CLSOED` → cast, not validated, so a typo silently returned an empty page.

All three came from URLs a person types, bookmarks or shares. **FIXED** in `lib/queries.ts`
(`parseDate`, `parseLimit`, and `STATUSES.find`). The same class of bug in `ingestSnapshot`
(`capturedAt: z.string()` written straight to a `DateTime` column) is **FIXED** too — it is now
validated, so a malformed payload gets the 422 it deserves instead of a 500.

## 5. A malformed env var could turn the grader into a hot loop

**Severity: medium. FIXED.**

Every entry in `config` was `Number(process.env.X ?? default)`. `Number("15m")` is `NaN`, and
`startGrader` does `setInterval(fn, Math.max(1, NaN) * 60_000)` — `setInterval` treats `NaN` as `0`,
so a single typo in `GRADE_POLL_MINUTES` would hammer ESPN and MLB as fast as the event loop allows.
That is the sort of thing that gets an IP blocked.

**FIXED:** `envNumber` falls back to the documented default and warns. `.env.example` also still
documented `CLOSING_BUFFER_MINUTES`, which no longer exists — replaced with the real
`CLOSING_READ_*` window settings.

## 6. Queued captures retried forever

**Severity: medium. FIXED.**

`flushQueue` in the extension incremented `attempts` on every failure and never read it. A payload
the server permanently rejects (a spread with no team attached, say — a 422 the user was already
told about at capture time) was re-POSTed every 60 seconds for as long as the browser stayed open,
only ever leaving via the 200-item cap. **FIXED:** dropped after `MAX_QUEUE_ATTEMPTS` (20) with a
console line naming the pick.

## 7. No error boundary

**Severity: medium. FIXED.**

Any throw in a Server Component rendered Next's default error screen: blank, no navigation, no
reason. Added `app/error.tsx`, which shows the message and offers a retry. The message is shown
rather than hidden deliberately — this is a private single-user tool, and a withheld reason turns a
one-minute fix into an evening.

## 8. Odds modal: the whole dialog navigated to the pick

**Severity: medium (user-reported). FIXED.**

The dialog was rendered inside `<tr className="row-link">`, whose click handler navigated to the
pick unless the click landed on an anchor or button. Everything in the dialog — a table cell, the
timestamp line, blank space — failed that test, so reading the dialog closed it.

Worth being precise about the fix, because the obvious one does not work: **a React portal does not
escape event bubbling.** React routes a portal's events through the React tree, not the DOM tree, so
moving the dialog to `document.body` leaves it bubbling into the row exactly as before. The portal
is still worth having — a fixed-position dialog nested in a `<td>` gets clipped and mis-stacked by
the scrolling table — but it is a layout fix.

**FIXED** with the two things that actually stop the navigation, plus the portal:

1. The scrim stops propagation, so nothing in the dialog reaches an ancestor handler.
2. The row no longer navigates at all. Only the pick's own name does — a real `<a href>` that
   middle-clicks and previews on hover. `BetRow` keeps just its right-click menu.
3. The dialog renders through `createPortal` onto `document.body`, for the layout reason above.

## 9. Odds modal load time

**Severity: high (user-reported). FIXED — see the README section "The Odds modal reads from the
server, not the queue".**

The old path was: modal opens → server parks the request in a queue → extension notices on its next
`chrome.alarms` tick (**one minute is Chrome's hard floor**, and the alarm ran the entire closing
queue first) → extension reads → POSTs back → the modal's 3-second poll finally sees it. Typical
wait 30–70 seconds for a read that takes ~300ms.

Now: the extension relays PropProfessor's bearer token to `/api/pp-token`, and the server makes the
request itself inside the modal's own round trip. The extension queue survives only as the fallback
for "the server has no token yet", which is the one thing the extension can uniquely fix.

Also fixed alongside it:

- **Missing sportsbook logos.** The odds screen is JSON and ships no images, so every row read
  through it had `logoUrl: null` while the bet page's own tables showed icons. `bookLogoUrl` in
  `shared/src/books.ts` maps book name → domain → favicon; `book-logos.test.ts` asserts every book
  in the captured fixtures resolves, and that the substring collisions this project has been bitten
  by before (BetRivers vs Betr) resolve to the right one.
- **Superseded responses.** A Refresh fired while the first read was in flight could overwrite the
  newer answer with the older one. The modal now tags each request and ignores stale replies.
- **A ten-second response cache**, so opening the modal on four picks in the same market is one
  request. Refresh bypasses it.

**Remaining risk, flagged rather than fixed:** the server-side read is untested against the live
host. If `backend.propprofessor.com` rejects a non-browser client (Cloudflare, TLS fingerprinting,
an Origin check), `readScreenNow` throws, `previewNow` reports `READ_FAILED` and the modal shows the
message — it does **not** fall back to the extension on a transport error, only on a missing token.
Verify against the live endpoint before release. If it turns out to be blocked, the one-line change
is to treat a non-2xx from the screen as a fallback condition in `previewNow`.

## 10. Smaller things, not fixed

- **The average closing price is not persisted.** `avgClosingPrice` is computed by
  `buildClosingVerdict` and shown in both modals, but unlike `avgClosingLine` and `priceEdge` it has
  no column on `Bet`, so it is not queryable, sortable on `/bets`, or chartable on `/analysis`. The
  per-book prices *are* stored on `CloseLine`, so a backfill needs no new capture — just a column, a
  `prisma db push`, and a recompute. Worth doing: on whole-number markets (touchdowns, home runs,
  made threes) the price is the only CLV signal there is, and right now it is visible but not
  measurable.
- **The odds button is OddsJam-only.** PropProfessor's checkbox lives in a 24px overlay lane with
  open layout complaints in `docs/Bugs.md`; adding a second control there should happen with that
  lane looked at properly. Flipping `oddsButton: true` on the PropProfessor adapter is the whole
  change once it is.
- **No index on `Bet.createdAt`**, which is the default `orderBy` for `/bets`, nor on
  `closeCapturedAt`, which orders the exclusion audit. Irrelevant at current volume; a one-line
  schema change when it stops being.
- **`server/storageState/`** was untracked but not ignored — an empty directory named like a
  Playwright session dump. Added to `.gitignore` so nothing lands there by accident.
- **Legacy closing-snapshot payload support** (`apply-closing.ts`'s `asOutcome`, the optional
  `row`/`parseOk` fields) was kept "for one release" so an un-reloaded extension keeps working. That
  release has happened. It is dead weight now and is worth deleting, which also removes a path that
  cannot distinguish "not offered" from "never loaded" — the exact collapse the redesign existed to
  undo.
- **Extension version is still `0.1.0`** in `manifest.json` and has never been bumped. Every install
  has to be reloaded by hand; a version number is the only way to tell which build a browser is
  running when a report comes in.
- **Dead code:** `aria-describedby={disabledReason ? undefined : undefined}` in `action-button.tsx`,
  and `void origin;` in the extension's `options.ts`.
- **`/api/odds-preview-work` drains its queue with no lease.** Documented and fine for one browser;
  with two extensions running, whichever polls first takes the work and the other gets nothing. Only
  matters if the fallback path ever becomes the primary one again.
- **No linter is configured.** `next lint` is deprecated and prompts to set ESLint up from scratch,
  so nothing currently catches the dead code above, an unused import, or a missing hook dependency.
  Worth a flat config before release; `npm run build` type-checks but does not lint.
- **No structured logging.** `console.log`/`warn`/`error` throughout, going to
  `/tmp/clv-analyzer.log` via the launch agent. Fine for one user; there is no log rotation, so that
  file grows without bound.

---

## What was checked and found sound

Worth recording, so a later pass does not re-audit the same ground:

- **The OddsJam rule holds.** No module that can initiate a request names `oddsjam.com`.
  `oddsjam-automation-guard.test.ts` enforces it, and this pass **extended it to the server**, which
  now makes outbound reads of its own (`pp-screen-read.ts`, `odds-preview.ts`, `pp-token.ts`).
- **`isAuthorized` is a constant-time compare** and refuses outright while `API_KEY` is `change-me`,
  so a default install fails closed rather than open.
- **The token bridge is minimal and honest**: it reads an `Authorization` header off requests the
  site's own app was already making, on propprofessor.com only, in page context, and forwards it
  through an origin-checked relay. The background worker additionally verifies `sender.url` before
  trusting a token message.
- **External fetches have abort timeouts** (`fetchJson`, 20s; the new screen read, 9s), so no source
  can stall the grader or hold a page open.
- **CLV arithmetic is well covered** — 143 tests, including the MAD outlier test, moneyline
  probability handling, de-vig, weighted averages and the fixture-driven screen parser.
- **Retry policy distinguishes real failures from unpriceable markets**, so a pick nobody quotes
  does not burn its fetch budget and get written off as broken. The table in `apply-closing.ts` is
  the clearest statement of that in the codebase.
- **Grading refuses to guess.** An unmatched player returns a reason, not a value; a player who did
  not appear is VOID rather than a zero that auto-wins every Under.
