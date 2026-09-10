"use client";

import { useEffect, useState } from "react";

/**
 * Highlights whichever settings section link matches the current URL hash, kept in sync with
 * both in-page clicks and back/forward navigation (which changes the hash without a click).
 */
export function SettingsNav({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setActive(window.location.hash.replace(/^#/, "") || null);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <nav className="settings-nav" aria-label="Settings sections">
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
