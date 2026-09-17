"use client";

import { useEffect, useState } from "react";

/**
 * Highlights whichever section link matches the current URL hash, kept in sync with both
 * in-page clicks and back/forward navigation (which changes the hash without a click).
 *
 * Not settings-specific despite the name it started with -- the sidebar layout it renders into
 * (`.settings-layout` / `.settings-sidebar` / `.settings-content` in globals.css) is reused as-is
 * by the Methodology and About pages, which is why `ariaLabel` is a prop rather than hardcoded.
 */
export function SettingsNav({
  sections,
  ariaLabel = "Settings sections",
}: {
  sections: { id: string; label: string }[];
  ariaLabel?: string;
}) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setActive(window.location.hash.replace(/^#/, "") || null);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <nav className="settings-nav" aria-label={ariaLabel}>
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={active === s.id ? "active" : undefined}
          onClick={() => setActive(s.id)}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
