import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropProfessorDisabledError, readScreenNow } from "../pp-screen-read";
import { storePpToken } from "../pp-token";

/**
 * `readScreenNow` used to be the Odds modal's fast path: a direct server-side POST to
 * PropProfessor's odds screen. That automation is what got the PropProfessor account banned
 * (2026-09), so this now asserts the opposite of what it used to -- that the function refuses
 * unconditionally, before it ever touches the network, no matter what token is on hand.
 */
describe("readScreenNow", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("throws without making a request, even with a token stored", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(readScreenNow()).rejects.toBeInstanceOf(PropProfessorDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws with no token too", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(readScreenNow()).rejects.toBeInstanceOf(PropProfessorDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
