"use client";

import { useRouter } from "next/navigation";

/**
 * "All picks" used to be a plain `<a href="/bets">`, which always landed on /bets no matter where
 * the click came from -- most visibly from /exclusions, where following an example back to its
 * pick and then hitting "back" dropped you on the picks list instead of the exclusions page you
 * were actually on.
 *
 * The referrer is what decides it: same-origin means the previous page in this tab really was
 * somewhere in this app (the picks list, the exclusions page, a filtered search), so `router.back()`
 * returns to exactly that page and its scroll/filter state. A missing or cross-origin referrer
 * (a bookmark, a pasted link, a link from outside the app) falls back to `fallbackHref` instead of
 * guessing at history that may not even belong to this page.
 */
export function BackLink({ fallbackHref, label }: { fallbackHref: string; label: string }) {
  const router = useRouter();

  return (
    <a
      href={fallbackHref}
      className="muted"
      onClick={(e) => {
        if (typeof document === "undefined" || !document.referrer) return;
        let sameOrigin = false;
        try {
          sameOrigin = new URL(document.referrer).origin === window.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) return;
        e.preventDefault();
        router.back();
      }}
    >
      {label}
    </a>
  );
}
