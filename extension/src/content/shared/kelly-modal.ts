import {
  KELLY_PRESETS,
  evaluateKelly,
  pointsBetween,
  shiftAmerican,
  type KellyResult,
} from "@clv/shared";
import { el, makeDraggable } from "./odds-modal";
import { saveKellySettings, type KellySettings } from "./kelly-settings";

/**
 * "How much do I actually put on this", asked straight from the board.
 *
 * The board already tells you a line is off the market. It never tells you the stake, and until now
 * that step happened in a phone calculator on the side.
 *
 * The input is deliberately the discrepancy in odds points -- "Fliff is -110, everyone else is
 * -140, that's 30" -- because that is what a human reads off a board. The arithmetic behind it all
 * lives in `shared/src/kelly.ts`, shared with the dashboard's own /kelly tab so the two can never
 * quote different stakes for the same bet.
 *
 * The button that opens it lives beside the odds-lookup icon (see `oddsButton` in
 * `./odds-modal.ts`), stacked in the same `.clva-stack` lane -- see `ownPriceFor` in
 * `./inject.ts`, which pre-fills the price from the row's own book column when there is one, and
 * `../oddsjam/index.ts`'s `kelly` gate for which boards get the icon at all.
 */

export const KELLY_MODAL_STYLES = `
.clva-kelly-modal {
  background: #131a23; color: #e6edf6; border: 1px solid #243040; border-radius: 11px;
  padding: 18px 20px; width: min(460px, calc(100vw - 40px));
  max-height: min(88vh, 820px); overflow-y: auto;
  box-shadow: 0 22px 55px rgba(0,0,0,0.65);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.clva-kelly-modal button {
  font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: #182231; color: #e6edf6; border: 1px solid #243040;
}
.clva-kelly-modal button:disabled { opacity: 0.55; cursor: default; }

.clva-kelly-presets { display: flex; gap: 6px; margin: 14px 0 12px; }
.clva-kelly-presets button { flex: 1 1 0; padding: 6px 4px; font-size: 12px; }
.clva-kelly-presets button[aria-pressed="true"] {
  border-color: var(--clva-accent); color: var(--clva-accent);
}

.clva-kelly-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.clva-kelly-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.clva-kelly-field span {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b9bb0;
}
.clva-kelly-field input {
  font: inherit; width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 7px;
  background: #0d141c; color: #e6edf6; border: 1px solid #243040;
  font-variant-numeric: tabular-nums;
}
.clva-kelly-field input:focus { outline: none; border-color: var(--clva-accent); }

.clva-kelly-out {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px;
  margin: 15px 0 0; padding: 13px 0 0; border-top: 1px solid #1d2633;
}
.clva-kelly-out div { min-width: 0; }
.clva-kelly-out i {
  font-style: normal; display: block; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.06em; color: #8b9bb0;
}
.clva-kelly-out b { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.clva-kelly-out s { text-decoration: none; display: block; color: #8b9bb0; font-size: 12px; }
.clva-kelly-actions { display: flex; gap: 8px; margin-top: 15px; }
.clva-kelly-actions button { flex: 1 1 0; }
.clva-kelly-actions .clva-kelly-primary {
  background: var(--clva-accent); border-color: var(--clva-accent); color: #06110b; font-weight: 600;
}
.clva-kelly-foot { color: #8b9bb0; font-size: 12px; margin: 13px 0 0; }
`;

export interface KellyContext {
  /** The row's own price, when the caller found one. Null opens the field blank for hand entry. */
  price: number | null;
  /** What the bet is, for the modal's subtitle. */
  label: string;
  /**
   * The saved Kelly numbers, already fetched by the caller.
   *
   * Passed in rather than fetched here because the caller has already asked for them -- the board
   * allowlist that decided whether to show the button at all comes from the same read -- and a
   * modal that opens with empty fields and fills them a tick later is worse than one that opens
   * complete.
   */
  settings: KellySettings;
}

function fmtOdds(price: number): string {
  return price > 0 ? `+${price}` : `${price}`;
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * One labelled number box, appended to `into` and handed back for its value and its events.
 *
 * `min` is always set to 0: with no `min`, a browser bases step validation on the field's initial
 * `value` rather than on zero, so a stored multiplier that (via an old save, or a manual DB edit)
 * isn't itself a clean multiple of `step` makes every *other* clean multiple invalid too --
 * rejecting 0.25 with "the two nearest valid values are 0.21 and 0.26" if the stored default
 * happened to be 0.21.
 */
function field(into: HTMLElement, label: string, value: string, step: string): HTMLInputElement {
  const wrap = el("label", "clva-kelly-field");
  wrap.appendChild(el("span", undefined, label));
  const input = el("input");
  input.type = "number";
  input.inputMode = "decimal";
  input.step = step;
  input.min = "0";
  input.value = value;
  wrap.appendChild(input);
  into.appendChild(wrap);
  return input;
}

/**
 * Opens the calculator.
 *
 * Every field is live: each keystroke re-runs `evaluateKelly` and repaints the six numbers below.
 * The discrepancy and the fair price are two views of one value and rewrite each other, never
 * themselves -- rewriting the field being typed in fights the cursor.
 */
export function openKellyModal(ctx: KellyContext): void {
  const scrim = el("div", "clva-scrim");
  const modal = el("div", "clva-kelly-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", `Kelly stake for ${ctx.label}`);

  const head = el("div", "clva-odds-head");
  const titles = el("div");
  titles.appendChild(el("h3", undefined, "Kelly stake"));
  titles.appendChild(el("div", "clva-sub", ctx.label));
  head.appendChild(titles);
  const actions = el("div", "clva-odds-head-actions");
  const close = el("button", undefined, "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  actions.appendChild(close);
  head.appendChild(actions);
  modal.appendChild(head);

  const presets = el("div", "clva-kelly-presets");
  modal.appendChild(presets);

  const fields = el("div", "clva-kelly-fields");
  const priceInput = field(fields, "Your odds", ctx.price === null ? "" : String(ctx.price), "5");
  const pointsInput = field(fields, "Discrepancy (pts)", "", "5");
  const fairInput = field(fields, "Fair odds", "", "5");
  const bankrollInput = field(
    fields,
    "Bankroll ($)",
    ctx.settings.bankroll ? String(ctx.settings.bankroll) : "",
    "100"
  );
  const multiplierInput = field(
    fields,
    "Kelly multiplier",
    String(ctx.settings.kellyMultiplier),
    "0.05"
  );
  const unitInput = field(
    fields,
    "Unit size ($)",
    ctx.settings.unitSize ? String(ctx.settings.unitSize) : "",
    "10"
  );
  modal.appendChild(fields);

  const out = el("div", "clva-kelly-out");
  modal.appendChild(out);

  const buttons = el("div", "clva-kelly-actions");
  const saveDefaults = el("button", undefined, "Save as defaults");
  saveDefaults.type = "button";
  buttons.appendChild(saveDefaults);
  modal.appendChild(buttons);

  const foot = el("p", "clva-kelly-foot");
  modal.appendChild(foot);

  scrim.appendChild(modal);

  const onPointerUp = makeDraggable(modal, head);

  const done = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    onPointerUp();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // OddsJam's own dialog closes on Escape too; only ours should
      done();
    }
  };
  close.addEventListener("click", done);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) done();
  });
  // Nothing that happens inside this dialog is the page's business -- least of all a click
  // reaching OddsJam's modal, which sits directly underneath it.
  scrim.addEventListener("click", (e) => e.stopPropagation());
  scrim.addEventListener("mousedown", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);

  const num = (input: HTMLInputElement): number => Number(input.value);

  function syncFairFromPoints(): void {
    const price = num(priceInput);
    const points = num(pointsInput);
    if (Number.isFinite(price) && price !== 0 && Number.isFinite(points) && pointsInput.value !== "") {
      fairInput.value = String(shiftAmerican(price, points));
    }
  }

  function stat(label: string, value: string, sub: string, tone?: "good" | "bad"): HTMLElement {
    const box = el("div");
    box.appendChild(el("i", undefined, label));
    box.appendChild(el("b", tone === "good" ? "clva-good" : tone === "bad" ? "clva-bad" : undefined, value));
    box.appendChild(el("s", undefined, sub));
    return box;
  }

  let current: KellyResult | null = null;

  function render(): void {
    current = evaluateKelly({
      price: num(priceInput),
      fairPrice: num(fairInput),
      bankroll: num(bankrollInput),
      multiplier: num(multiplierInput),
      unitSize: num(unitInput),
    });

    for (const preset of presetButtons) {
      preset.button.setAttribute(
        "aria-pressed",
        String(Number(multiplierInput.value) === preset.value)
      );
    }

    if (!current) {
      out.replaceChildren(
        el(
          "p",
          "clva-kelly-foot",
          Number(bankrollInput.value) > 0
            ? "Enter a price and a fair price to see the stake."
            : "Set a bankroll — here, or on the dashboard's Settings page to keep it."
        )
      );
      foot.textContent = "";
      return;
    }

    const r = current;
    out.replaceChildren(
      stat(
        "Stake",
        money(r.stake),
        `${r.units.toFixed(2)} units at ${money(r.unitSize)}`
      ),
      stat(
        "Expected value",
        `${r.evPercent > 0 ? "+" : ""}${r.evPercent.toFixed(2)}%`,
        `${r.points > 0 ? "+" : ""}${r.points} pts of edge`,
        r.evPercent > 0 ? "good" : "bad"
      ),
      stat("Of bankroll", pct(r.fraction), `${Number(multiplierInput.value)}x Kelly`),
      stat("Fair win rate", pct(r.fairProbability, 1), `full Kelly is ${pct(r.fullKellyFraction)}`)
    );
    foot.textContent =
      `An entered ${fmtOdds(num(fairInput))} is taken to mean ${pct(r.fairProbability, 1)} to win. ` +
      `There is only one side here, so nothing is de-vigged — if that is a vigged consensus price, ` +
      `this stake is high by roughly half the hold.`;
  }

  const presetButtons = KELLY_PRESETS.map((preset) => {
    const button = el("button", undefined, preset.label);
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      multiplierInput.value = String(preset.value);
      render();
    });
    presets.appendChild(button);
    return { button, value: preset.value };
  });

  pointsInput.addEventListener("input", () => {
    syncFairFromPoints();
    render();
  });
  fairInput.addEventListener("input", () => {
    const price = num(priceInput);
    const fair = num(fairInput);
    if (Number.isFinite(price) && price !== 0 && Number.isFinite(fair) && fair !== 0) {
      pointsInput.value = String(pointsBetween(price, fair));
    }
    render();
  });
  priceInput.addEventListener("input", () => {
    syncFairFromPoints();
    render();
  });
  for (const input of [bankrollInput, multiplierInput, unitInput]) {
    input.addEventListener("input", render);
  }

  // Writes through to the server's settings row -- the same one the dashboard's Settings page
  // edits -- so a bankroll adjusted here is the bankroll everywhere.
  saveDefaults.addEventListener("click", () => {
    saveDefaults.disabled = true;
    saveDefaults.textContent = "Saving…";
    void (async () => {
      const result = await saveKellySettings({
        bankroll: Number(bankrollInput.value) || 0,
        kellyMultiplier: Number(multiplierInput.value) || ctx.settings.kellyMultiplier,
        unitSize: Number(unitInput.value) || 0,
      });
      saveDefaults.textContent = result.ok ? "Saved" : "Could not save";
      saveDefaults.title = result.ok ? "" : (result.error ?? "");
      if (!result.ok) {
        saveDefaults.disabled = false;
        return;
      }
      setTimeout(() => {
        saveDefaults.textContent = "Save as defaults";
        saveDefaults.disabled = false;
      }, 1400);
    })();
  });

  document.body.appendChild(scrim);

  render();
  pointsInput.focus();
}

/** The little icon that opens it, styled and sized to match `oddsButton` in the same stack. */
export function kellyButton(onOpen: () => void): HTMLButtonElement {
  const button = el("button", "clva-odds-btn");
  button.type = "button";
  button.title = "Kelly stake calculator for this bet";
  button.setAttribute("aria-label", "Kelly stake calculator for this bet");
  // A "K" drawn in straight strokes, matching the odds button's own abstract-glyph style rather
  // than spelling anything out -- see the Trusted Types note on that one for why this is built
  // node by node instead of assigned as innerHTML.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 1V11M2 6L10 1M2 6L10 11");
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  return button;
}
