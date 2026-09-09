"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WIDTH = 290;
const GAP = 8;
const MARGIN = 10;

/**
 * A short "how is this calculated" note attached to a stat.
 *
 * Kept to a sentence or two inline; anything that needs real derivation lives on /methodology and
 * is linked from here, so the dashboard stays readable but nothing is unexplained.
 *
 * The bubble renders in a portal with fixed positioning rather than as an absolutely-positioned
 * child. Tables carry `overflow: hidden` for their rounded corners, which clipped the bubble
 * whenever it was taller than the space left below the button -- most visibly on a /bets table
 * holding a single row. Escaping to the body means no ancestor can crop it, and it flips above
 * the button when there is not enough room below.
 */
export function Info({
  title,
  children,
  anchor,
}: {
  title: string;
  children: React.ReactNode;
  /** Heading id on /methodology for the full derivation. */
  anchor?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const height = popRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    // Flip above only when there is genuinely more room there, so the default stays "below".
    const flip = height > below && r.top - GAP - MARGIN > below;
    const top = flip ? Math.max(MARGIN, r.top - GAP - height) : r.bottom + GAP;
    const left = Math.min(
      Math.max(MARGIN, r.left - 8),
      Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN)
    );
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Fixed positioning does not follow the page, so close on scroll rather than leave it stranded.
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <span className="info">
      <button
        type="button"
        ref={btnRef}
        className="info-btn"
        aria-expanded={open}
        aria-label={`How ${title} is calculated`}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            ref={popRef}
            className="info-pop"
            role="dialog"
            aria-label={`${title} — how it is calculated`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              // Hidden until measured, so it never flashes in the wrong place.
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <strong>{title}</strong>
            <span className="info-body">{children}</span>
            <a href={anchor ? `/methodology#${anchor}` : "/methodology"}>Full method →</a>
          </span>,
          document.body
        )}
    </span>
  );
}
