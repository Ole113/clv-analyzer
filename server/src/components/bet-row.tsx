"use client";

/**
 * One pick's row in the /bets table.
 *
 * The row used to be clickable anywhere, with a handler that skipped clicks landing on an anchor or
 * button. Two things were wrong with that, and both are why it is gone:
 *
 *  - It swallowed clicks it had no business seeing. The Odds dialog opens from a button inside this
 *    row, so clicking anywhere in that dialog -- a table cell, blank space -- navigated to the pick
 *    instead. Portalling the dialog to `document.body` does not by itself fix that: React routes a
 *    portal's events through the React tree rather than the DOM tree, so it still bubbles to
 *    whatever rendered it. A row-wide handler is a standing trap for anything mounted inside it.
 *  - "Clickable unless it isn't" is not discoverable. The pick's name is a real link, with a real
 *    href, that middle-clicks and previews on hover like every other link in the app.
 *
 * So the row now carries only its right-click menu; navigation belongs to the anchor in the Pick
 * cell (see `bets-table.tsx`), which is the one thing on the row that looks like it navigates.
 */
export function BetRow({
  onContextMenu,
  children,
}: {
  onContextMenu?: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <tr className="bet-row" onContextMenu={onContextMenu}>
      {children}
    </tr>
  );
}
