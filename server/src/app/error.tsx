"use client";

import { useEffect } from "react";

/**
 * The last line of defence for a page that threw.
 *
 * Without this, an unhandled error anywhere in a Server Component renders Next's own generic error
 * screen -- a blank page with no navigation, no explanation, and no way back other than the browser
 * button. Every page here is a dashboard read: a failure is worth showing honestly and recovering
 * from in place, which is what `reset()` does (it re-renders the segment without a full reload).
 *
 * The message is shown rather than hidden. This is a single-user tool reached over a private
 * network, and "Something went wrong" with the actual reason withheld is exactly what makes a bug
 * take an evening instead of a minute.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[page]", error);
  }, [error]);

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>This page could not be loaded</h2>
      <p className="muted">
        Something threw while rendering. The details are below and in the server log.
      </p>
      <pre className="err" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div className="inline" style={{ marginTop: 16 }}>
        <button type="button" className="primary" onClick={reset}>
          Try again
        </button>
        <a className="ext" href="/">
          Back to the overview
        </a>
      </div>
    </main>
  );
}
