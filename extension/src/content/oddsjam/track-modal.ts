import { normalizeBookKey } from "@clv/shared";
import { DEFAULT_KELLY_SETTINGS, kellySettings, type KellySettings } from "../shared/kelly-settings";
import { openKellyModal } from "../shared/kelly-modal";

/**
 * The Kelly button inside OddsJam's own "Add to Bet Tracker" modal.
 *
 * That modal is the one place where the stake is actually being decided -- it opens with the bet's
 * price already filled in and an "Amount Staked" box waiting for a number -- so it is where the
 * calculator belongs. This module finds it and adds one button; everything the button opens lives
 * in `../shared/kelly-modal.ts`.
 *
 * Two things it deliberately does not do:
 *
 *  - **It never clicks anything of OddsJam's.** The board adapter's own rule about their TRACK
 *    column still holds: the column is not read and not clicked. This observes the modal a human
 *    opened, and nothing else.
 *  - **It never re-parents OddsJam's nodes.** React unmounts by node reference, and moving a node
 *    it owns into a wrapper of ours is how their modal ends up throwing `NotFoundError` on close.
 *    Our button is added as an extra child; their layout is nudged with one CSS property, keyed off
 *    an attribute of ours, rather than by editing their class list.
 */

const MARK = "data-clva-kelly";
const FOOTER_MARK = "data-clva-kelly-footer";

/** How the tracker modal names itself. Matched on text, since the ids are per-render. */
const TITLE = "add to bet tracker";

/**
 * OddsJam's tracker modal, if it is open.
 *
 * Identified by the Headless UI panel id prefix plus its own title and price field -- never by the
 * generated suffix (`headlessui-dialog-panel-_r_30_`), which changes on every render.
 */
function trackerPanel(): HTMLElement | null {
  const panels = Array.from(
    document.querySelectorAll<HTMLElement>('[id^="headlessui-dialog-panel-"]')
  );
  return (
    panels.find((panel) => {
      const title = panel.querySelector('[id^="headlessui-dialog-title-"]');
      const named = (title?.textContent ?? "").trim().toLowerCase() === TITLE;
      return named && panel.querySelector("#oddPrice") !== null;
    }) ?? null
  );
}

/** The row holding Cancel and Save, which is where the button goes. */
function footer(panel: HTMLElement): HTMLElement | null {
  const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
  const save = buttons.find((b) => (b.textContent ?? "").trim().toLowerCase() === "save");
  // The button text sits two divs deep inside the <button>, so the footer is the button's parent,
  // found from the button rather than by matching OddsJam's utility class soup.
  return save?.parentElement ?? null;
}

function priceIn(panel: HTMLElement): number | null {
  const input = panel.querySelector<HTMLInputElement>("#oddPrice");
  if (!input) return null;
  const value = Number(input.value);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function labelIn(panel: HTMLElement): string {
  const name = panel.querySelector<HTMLInputElement>("#betName")?.value.trim();
  return name && name.length > 0 ? name : "this bet";
}

/**
 * Writes a value into one of the modal's inputs.
 *
 * Assigning `input.value` directly is not enough: React tracks the last value it rendered on the
 * node itself, sees no change, fires no `onChange`, and overwrites whatever was typed on the next
 * render. Going through the prototype's own setter is what makes React's tracker notice.
 */
function setReactValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The board slug in `/fantasy-odds/<slug>`, normalized the same way the allowlist is. */
function boardKey(): string | null {
  const match = location.pathname.match(/\/fantasy-odds\/([^/?#]+)/);
  if (!match) return null;
  try {
    return normalizeBookKey(decodeURIComponent(match[1]));
  } catch {
    return normalizeBookKey(match[1]);
  }
}

/**
 * Whether this board quotes real prices.
 *
 * Exact equality after normalizing both sides, not a substring test: the entries are board slugs,
 * and several are prefixes of others, so a substring match would light up boards nobody listed.
 * Normalizing both sides is what lets "dogg-house" in the settings match a "dogg_house" slug.
 */
function allowed(boards: string[], board: string | null): boolean {
  if (!board) return false;
  return boards
    .map((entry) => normalizeBookKey(entry))
    .some((entry) => entry !== null && entry === board);
}

function openFor(panel: HTMLElement, settings: KellySettings): void {
  const stake = panel.querySelector<HTMLInputElement>("#stake");
  openKellyModal({
    price: priceIn(panel),
    label: labelIn(panel),
    // Re-read on every one of their input events rather than polling: editing the price in their
    // modal should move the stake in ours, and the two are the same decision.
    watchPrice: (onChange) => {
      const input = panel.querySelector<HTMLInputElement>("#oddPrice");
      if (!input) return () => {};
      const handler = () => onChange(priceIn(panel));
      input.addEventListener("input", handler);
      return () => input.removeEventListener("input", handler);
    },
    applyStake: stake
      ? (value) => setReactValue(stake, value.toFixed(2))
      : undefined,
    // Mounted inside their panel so their focus trap and outside-click check both count it as
    // part of the dialog -- see `KellyContext.host`.
    host: panel,
    settings,
  });
}

function inject(settings: KellySettings): void {
  // The gate is re-checked on every pass, not once at startup: the board swaps without a reload
  // when the fantasy book changes, and the allowlist can be edited on the dashboard's Settings page
  // while a board is open.
  const board = boardKey();
  if (!allowed(settings.kellyBoards, board)) {
    if (board && board !== warnedAbout) {
      warnedAbout = board;
      console.info(
        `[CLV Analyzer] Kelly is off for the "${board}" board. Add that name under Kelly staking ` +
          `on the dashboard's Settings page if it quotes real American odds.`
      );
    }
    return;
  }

  const panel = trackerPanel();
  if (!panel || panel.hasAttribute(MARK)) return;

  const host = footer(panel);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "clva-kelly-btn";
  button.textContent = "Kelly";
  button.title = "Work out the stake for this price";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openFor(panel, settings);
  });

  if (host) {
    host.setAttribute(FOOTER_MARK, "1");
    host.insertBefore(button, host.firstChild);
  } else {
    // No footer found -- a layout change, or a variant of the modal without Cancel/Save. The panel
    // is already `position: relative` with 24px of padding, so the same corner is one step away.
    button.style.position = "absolute";
    button.style.left = "24px";
    button.style.bottom = "24px";
    panel.appendChild(button);
  }
  panel.setAttribute(MARK, "1");
}

/** The last board named in the console, so switching boards says so once and then stays quiet. */
let warnedAbout: string | null = null;

/**
 * Watches for the tracker modal and keeps the button in it.
 *
 * Repeated rather than one-shot, and idempotent, for the same reason `injectRows` is: the modal is
 * React-rendered and re-renders on every keystroke in it, which can drop a foreign child. The panel
 * carries the marker, so a re-rendered panel is a new node without it and gets a new button.
 */
export function startKellyButton(): void {
  let settings: KellySettings = DEFAULT_KELLY_SETTINGS;

  const run = () => {
    try {
      inject(settings);
    } catch (error) {
      console.warn("[CLV Analyzer] Kelly button injection failed:", error);
    }
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      run();
    }, 120);
  };

  /**
   * Re-reads the server's copy on a slow cadence, not on the injection cadence.
   *
   * The button is gated on the board list and the modal opens with the bankroll, so both need to be
   * current -- but neither changes often, and asking on every re-render would put a round trip
   * behind every keystroke in OddsJam's modal. The first read is immediate; after that this is just
   * keeping up with an edit made on the dashboard.
   */
  const refresh = () => {
    void kellySettings().then((next) => {
      settings = next;
      warnedAbout = null;
      schedule();
    });
  };

  refresh();
  setInterval(refresh, 60_000);

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // The same cheap safety net `startCapture` keeps, for the same reason: a re-render that lands
  // between observer callbacks should not leave the modal without its button.
  setInterval(schedule, 2000);
}
