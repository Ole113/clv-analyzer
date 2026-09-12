"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import type { ActionResult } from "@/components/action-button";
import { voidBetQuick, deleteBetQuick } from "@/lib/bet-actions";

type MenuState = { x: number; y: number; betId: string; betLabel: string } | null;

/**
 * A right-click quick-action menu for bet rows, positioned at the click. One instance per table --
 * open it via the returned `open(event, betId, betLabel)`, attached to each row's onContextMenu.
 */
export function useBetContextMenu() {
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const { push } = useToast();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Not while the delete confirmation is up: the menu div itself isn't even rendered then, so
    // `menuRef` is null and every click -- including on the modal's own Confirm button -- would
    // otherwise read as "outside" and clear `menu` before the confirm handler gets to read it.
    if (!menu || confirmingDelete) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, confirmingDelete]);

  const open = (event: React.MouseEvent, betId: string, betLabel: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, betId, betLabel });
  };

  const run = (action: (id: string) => Promise<ActionResult>) => {
    if (!menu) return;
    const { betId } = menu;
    setMenu(null);
    startTransition(async () => {
      try {
        const result = await action(betId);
        push("success", result?.message ?? "Done", result?.detail);
      } catch (error) {
        push("error", "That did not work", error instanceof Error ? error.message : "Unknown error");
      }
    });
  };

  const element = (
    <>
      {menu && !confirmingDelete && (
        <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" disabled={pending} onClick={() => run(voidBetQuick)}>
            Mark void
          </button>
          {/* Keeps `menu` set (just hides the menu div above) so its betId/betLabel survive for
              the confirm dialog -- clearing it here would leave the dialog with nothing to show
              or act on. */}
          <button type="button" className="danger" disabled={pending} onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        </div>
      )}
      <Modal
        open={confirmingDelete}
        title="Delete this pick?"
        body={`${menu?.betLabel ?? "This pick"} will be permanently removed, along with its snapshots. This cannot be undone.`}
        danger
        confirmLabel="Delete"
        onCancel={() => {
          setConfirmingDelete(false);
          setMenu(null);
        }}
        onConfirm={() => {
          setConfirmingDelete(false);
          run(deleteBetQuick);
        }}
      />
    </>
  );

  return { openContextMenu: open, contextMenuElement: element };
}
