"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SnapshotTable, type LineRow } from "@/components/snapshot-table";
import { fmtOdds } from "@/components/ui";
import { requestOddsPreview, pollOddsPreview } from "@/lib/bet-actions";
import type { OddsPreview } from "@/lib/odds-preview";
import { Signed } from "@/components/value";

/**
 * How often the modal checks back in the one case it still has to wait: the server had no
 * PropProfessor token, so the request was handed to the extension, whose `chrome.alarms` floor is a
 * minute. Nothing is gained by asking faster than this.
 */
const POLL_MS = 3000;

/**
 * How long the fallback path waits before giving up.
 *
 * Three `chrome.alarms` periods. Past that the extension is not coming -- no browser is running it,
 * or it has no PropProfessor session -- and an honest dead end with a retry button beats a spinner
 * that turns forever.
 */
const QUEUED_TIMEOUT_MS = 3 * 60_000;

type State =
  | { kind: "idle" }
  /** The server is reading the screen inside this request. Normally a few hundred milliseconds. */
  | { kind: "loading" }
  /** Handed to the extension because the server has no token yet; the slow path. */
  | { kind: "queued" }
  | { kind: "error"; reason: string }
  | { kind: "result"; preview: OddsPreview };

function toLineRows(preview: OddsPreview): LineRow[] {
  if (!preview.verdict) return [];
  return preview.verdict.closeLines.map((l, i) => ({
    id: `${l.bookKey}-${i}`,
    bookKey: l.bookKey,
    label: l.label,
    line: l.line,
    price: l.price,
    logoUrl: l.logoUrl,
    includedInAverage: l.includedInAverage,
  }));
}


/**
 * The headline numbers above the book table.
 *
 * Average **price** is shown next to average line, and that is the point of this component rather
 * than a detail of it. A passing-touchdowns prop reads "avg 2.50 · edge 0.00" forever -- the line
 * physically cannot move off 2.5, so the line average and the edge derived from it say nothing
 * about a market that may have travelled from -110 to -145 since the pick was taken. The price is
 * the only thing that moves on markets like that, and it was previously computed and thrown away.
 *
 * The two counts are shown separately when they differ, because they genuinely are different
 * fields: a book is kept in the line average whenever it quotes the market at all, including on one
 * side only, but it can only contribute a price for the side actually taken.
 */
function OddsSummary({ verdict, fetchedAt }: { verdict: OddsPreview["verdict"]; fetchedAt: string }) {
  if (!verdict) return null;
  const { avgClosingLine, avgClosingPrice, closingBookCount, closingPriceBookCount, edge } = verdict;

  return (
    <div className="odds-summary">
      <span className="muted">As of {new Date(fetchedAt).toLocaleTimeString()}</span>

      {avgClosingLine !== null && (
        <span className="odds-stat">
          <span className="odds-stat-label">Avg line</span>
          <strong>{avgClosingLine.toFixed(2)}</strong>
          <span className="muted">
            {closingBookCount} book{closingBookCount === 1 ? "" : "s"}
          </span>
        </span>
      )}

      {avgClosingPrice !== null && (
        <span className="odds-stat">
          <span className="odds-stat-label">Avg price</span>
          <strong>{fmtOdds(avgClosingPrice)}</strong>
          <span className="muted">
            {closingPriceBookCount} book{closingPriceBookCount === 1 ? "" : "s"}
          </span>
        </span>
      )}

      {edge !== null && (
        <span className="odds-stat">
          <span className="odds-stat-label">Edge</span>
          <Signed value={edge} />
        </span>
      )}
    </div>
  );
}

/**
 * Replaces the plain "odds ↗" link, which used to just send you to PropProfessor's screen to
 * search for the player by hand. This runs the exact same read the closing-line poller does --
 * same market resolution, same book-averaging, same "not averaged" treatment -- and shows it in
 * place.
 *
 * Three things about how it is mounted, and the order matters because the obvious fix is not the
 * one that works:
 *
 *  - **The scrim stops propagation.** On `/bets` this button lives inside a row that used to have
 *    its own click handler, and a click anywhere in the dialog that was not an anchor or button
 *    reached it and navigated to the pick -- closing the dialog mid-read. This is what actually
 *    fixes that, together with the row no longer being clickable at all (see `bet-row.tsx`).
 *  - **It renders through a portal onto `document.body`**, which is a layout fix rather than an
 *    event one. A portal deliberately does *not* escape event bubbling: React routes a portal's
 *    events through the React tree, not the DOM tree, so the dialog would still bubble into
 *    whatever it is rendered from. What the portal does escape is the table -- a fixed-position
 *    dialog nested in a `<td>` is otherwise clipped and stacked by the scrolling table around it.
 *  - It is **not** rendered at all until opened, so a list of 200 picks mounts 200 buttons and no
 *    dialogs.
 */
export function OddsPreviewButton({
  betId,
  label,
  fallbackUrl,
  fallbackNote,
  triggerLabel = "current odds ↗",
  triggerClassName = "link-button",
}: {
  betId: string;
  label: string;
  fallbackUrl: string;
  fallbackNote: string;
  /** Lets the /bets list match its compact "odds ↗" link styling instead of the detail page's
   *  inline-text one, without needing two components for the same modal. */
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on every request so a reply from a superseded one (a Refresh fired while the first was
   *  still in flight) cannot overwrite the newer answer. */
  const requestId = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const poll = useCallback((id: string, forRequest: number, giveUpAt: number) => {
    pollTimer.current = setTimeout(async () => {
      if (requestId.current !== forRequest) return;
      const { preview } = await pollOddsPreview(id);
      if (requestId.current !== forRequest) return;
      if (preview) {
        setState({ kind: "result", preview });
        return;
      }
      if (Date.now() >= giveUpAt) {
        setState({
          kind: "error",
          reason:
            "Your browser extension did not answer. Open PropProfessor in a tab so it can pick up " +
            "a session, then press Refresh.",
        });
        return;
      }
      // Nothing yet, and still inside the window: the extension's next alarm tick may pick it up.
      poll(id, forRequest, giveUpAt);
    }, POLL_MS);
  }, []);

  const start = useCallback(
    (refresh: boolean) => {
      stopPolling();
      const mine = ++requestId.current;
      setState({ kind: "loading" });
      void (async () => {
        try {
          const result = await requestOddsPreview(betId, { refresh });
          if (requestId.current !== mine) return;
          if (!result.ok) {
            setState({ kind: "error", reason: result.reason });
            return;
          }
          if (result.mode === "result") {
            setState({ kind: "result", preview: result.preview });
            return;
          }
          setState({ kind: "queued" });
          poll(betId, mine, Date.now() + QUEUED_TIMEOUT_MS);
        } catch (error) {
          if (requestId.current !== mine) return;
          setState({
            kind: "error",
            reason: error instanceof Error ? error.message : "The odds read could not be started.",
          });
        }
      })();
    },
    [betId, poll, stopPolling]
  );

  useEffect(() => {
    if (!open) return;
    start(false);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Abandons whatever is outstanding: a reply arriving after the dialog closed has nowhere to
      // go, and without the bump a reopened dialog would briefly show the last one's answer.
      requestId.current++;
      stopPolling();
    };
  }, [open, start, stopPolling]);

  const busy = state.kind === "loading" || state.kind === "queued";

  const dialog = (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) setOpen(false);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="odds-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Current odds for ${label}`}
      >
        <div className="odds-preview-header">
          <div>
            <h3 style={{ margin: 0 }}>Current odds</h3>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
          </div>
          <div className="odds-preview-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => start(true)}
              title="Read the odds screen again"
            >
              {busy ? <span className="spinner" aria-hidden="true" /> : "Refresh"}
            </button>
            <button type="button" aria-label="Close" ref={closeRef} onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
        </div>

        {state.kind === "loading" && (
          <div className="page-loading" style={{ padding: "30px 0" }}>
            <span className="spinner" aria-hidden="true" />
            Reading PropProfessor&apos;s odds screen…
          </div>
        )}

        {state.kind === "queued" && (
          <div className="page-loading" style={{ padding: "30px 0", textAlign: "center" }}>
            <span className="spinner" aria-hidden="true" />
            Waiting on your browser extension for a PropProfessor session — this first read can take
            up to a minute. Later ones are instant.
          </div>
        )}

        {state.kind === "error" && <p className="err">{state.reason}</p>}

        {state.kind === "result" && !state.preview.ok && <p className="err">{state.preview.reason}</p>}

        {state.kind === "result" && state.preview.ok && state.preview.verdict && (
          <>
            <OddsSummary verdict={state.preview.verdict} fetchedAt={state.preview.fetchedAt} />
            <SnapshotTable
              title="Live read"
              when="Pulled just now from PropProfessor's odds screen"
              lines={toLineRows(state.preview)}
              emptyNote="No book columns came back for this market."
            />
          </>
        )}

        <p className="muted" style={{ fontSize: 11, marginTop: 14 }}>
          {fallbackNote}{" "}
          <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">
            Open the odds screen manually ↗
          </a>
        </p>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        onClick={(e) => {
          // The trigger sits inside a row that has its own click handler on /bets.
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>

      {/* `document.body` only exists once mounted, which on a server-rendered page is after
          hydration -- and `open` can only become true from a click, which is later still. */}
      {open && typeof document !== "undefined" && createPortal(dialog, document.body)}
    </>
  );
}
