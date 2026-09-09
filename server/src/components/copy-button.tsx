"use client";

import { useState } from "react";

/**
 * Copies a value to the clipboard.
 *
 * Neither site accepts a player in its screen URL, so the last step is always pasting the name
 * into their own search box -- this removes the retyping.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}
