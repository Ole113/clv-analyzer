"use client";

import { useRouter } from "next/navigation";

/**
 * A pick row you can click anywhere to open.
 *
 * The outbound board/odds links inside the row keep working: a click that lands on (or inside) an
 * anchor or button is left alone, so "odds ↗" still opens the sportsbook rather than navigating
 * into the pick. Text selection is preserved too -- dragging to select does not count as a click.
 */
export function BetRow({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  const router = useRouter();

  const navigate = () => router.push(`/bets/${id}`);

  return (
    <tr
      className="row-link"
      tabIndex={0}
      role="link"
      aria-label={`Open ${label}`}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("a, button, input, select, label")) return;
        // A drag that selected text is not a click-through.
        if (window.getSelection()?.toString()) return;
        navigate();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as HTMLElement).closest("a, button, input, select")) return;
        event.preventDefault();
        navigate();
      }}
    >
      {children}
    </tr>
  );
}
