"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A short "how is this calculated" note attached to a stat.
 *
 * Kept to a sentence or two inline; anything that needs real derivation lives on /methodology and
 * is linked from here, so the dashboard stays readable but nothing is unexplained.
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
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="info" ref={ref}>
      <button
        type="button"
        className="info-btn"
        aria-expanded={open}
        aria-label={`How ${title} is calculated`}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <span className="info-pop" role="dialog" aria-label={`${title} — how it is calculated`}>
          <strong>{title}</strong>
          <span className="info-body">{children}</span>
          <a href={anchor ? `/methodology#${anchor}` : "/methodology"}>Full method →</a>
        </span>
      )}
    </span>
  );
}
