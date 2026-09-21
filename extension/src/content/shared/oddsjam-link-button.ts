import { el } from "./odds-modal";

/**
 * The button that opens OddsJam's own site for a row's market -- see the module comment on
 * `@clv/shared/oddsjam-site.ts` for what it resolves to and why it can only ever be a cache built
 * from pages the user opens themselves, never a live lookup.
 *
 * No modal: unlike the odds and Kelly buttons beside it, there is nothing to compute or show here --
 * `onOpen` resolves a URL and opens it in a new tab, full stop.
 */
export function oddsJamLinkButton(onOpen: () => void): HTMLButtonElement {
  const button = el("button", "clva-odds-btn");
  button.type = "button";
  button.title = "OddsJam odds for this market";
  button.setAttribute("aria-label", "OddsJam odds for this market");
  // A box with an arrow breaking out of its corner -- the standard "opens elsewhere" glyph, kept
  // visually distinct from the odds button's bar chart and Kelly's "K". Built node by node for the
  // same Trusted Types reason as its neighbours: see oddsButton's own comment in odds-modal.ts.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const box = document.createElementNS("http://www.w3.org/2000/svg", "path");
  box.setAttribute(
    "d",
    "M5 2H2.75A.75.75 0 0 0 2 2.75v6.5c0 .41.34.75.75.75h6.5a.75.75 0 0 0 .75-.75V7"
  );
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M7 2h3v3M10 2 5.3 6.7");
  svg.append(box, arrow);
  button.appendChild(svg);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  return button;
}
