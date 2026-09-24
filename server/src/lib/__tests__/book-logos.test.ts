import { describe, expect, it } from "vitest";
import { bookLogoUrl, normalizeBookKey } from "@clv/shared";
import { parseOddsTerminal } from "./support/odds-terminal-fixture";

/**
 * A JSON odds source ships no images, so every book line read through one used to come back with
 * `logoUrl: null` -- which is why the Odds modal rendered a wall of bare names next to numbers the
 * bet page shows with icons. `bookLogoUrl` fills that in from the book's name.
 *
 * The risk worth testing is not "does FanDuel get an icon"; it is the substring collisions this
 * project has already been bitten by once (see the note on SPORTSBOOK_HINTS about "BetRivers"
 * containing "betr"). A lookup that answers BetRivers with Betr's icon is worse than no icon.
 */

describe("book logos", () => {
  it("does not answer a book with a different book's icon", () => {
    expect(bookLogoUrl("betrivers", "BetRivers")).toContain("betrivers.com");
    expect(bookLogoUrl("betr", "Betr")).toContain("betr.app");
    // The DFS spin-off shares DraftKings' brand and icon; that is correct, not a collision.
    expect(bookLogoUrl("draftkings6", "DraftKings6")).toContain("draftkings.com");
    expect(bookLogoUrl("novig", "Novig")).toContain("novig.us");
  });

  it("recognizes the alt-line variants a board actually returns", () => {
    // "Betr (Alt)" normalizes to "betralt", which matches no key exactly.
    expect(bookLogoUrl(normalizeBookKey("Betr (Alt)")!, "Betr (Alt)")).toContain("betr.app");
    expect(bookLogoUrl(normalizeBookKey("Underdog (Alt)")!, "Underdog (Alt)")).toContain(
      "underdogfantasy.com"
    );
  });

  it("returns null for a book it has never heard of", () => {
    expect(bookLogoUrl("somebrandnewbook", "Some Brand New Book")).toBeNull();
    expect(bookLogoUrl("col-7", null)).toBeNull();
  });

  it("gives every book on a real captured market an icon", () => {
    // A live Odds Terminal read, which is where this actually bites: five books, no images, and
    // the modal has to look like the rest of the app.
    const { parsed } = parseOddsTerminal("Receptions");
    expect(parsed.ok).toBe(true);

    const lines = parsed.rows.flatMap((r) => r.bookLines);
    expect(lines.length).toBeGreaterThan(0);
    const missing = [...new Set(lines.filter((l) => !l.logoUrl).map((l) => l.label))];
    // Named rather than counted: a book falling out of the map should say which one it was.
    expect(missing).toEqual([]);
  });
});
