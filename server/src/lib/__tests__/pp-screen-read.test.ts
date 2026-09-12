import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClosingWorkItem } from "@clv/shared";
import { NoTokenError, readScreenNow } from "../pp-screen-read";
import { getPpToken, storePpToken } from "../pp-token";

/**
 * The server-side odds-screen read -- the Odds modal's fast path.
 *
 * What matters here is not the parsing (that is `pp-screen-source.test.ts`, against the same
 * fixtures) but the things only this module decides: that a read happens at all without the
 * extension, that a dead token is dropped rather than retried, and that several picks on one market
 * cost one request rather than one each. The last is the whole reason opening the modal is fast.
 */

const FIXTURES = join(__dirname, "../../../../shared/src/__fixtures__");
const rushingYards = JSON.parse(
  readFileSync(join(FIXTURES, "pp-screen-ncaaf-rushing-yards.json"), "utf8")
);

function item(overrides: Partial<ClosingWorkItem> = {}): ClosingWorkItem {
  return {
    id: "bet-1",
    site: "PROPPROFESSOR",
    fantasyBook: "",
    marketType: "PLAYER_PROP",
    player: "Xavier Robinson",
    subjectTeam: null,
    matchup: null,
    statMarket: "Rushing Yards",
    side: "UNDER",
    externalPropId: null,
    pageUrl: null,
    gameStartTime: null,
    sport: "NCAAF",
    takenLine: 21.5,
    ...overrides,
  };
}

/** A fresh Response per call: a body can only be read once, so a shared mock value would make the
 *  second read of the same market fail for a reason that has nothing to do with the code. */
function respondWith(body: unknown, status = 200) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
}

/** The module caches per (league, market) across calls, so each test needs a clean slate. */
function resetCaches(): void {
  (globalThis as { clvaScreenCache?: Map<string, unknown> }).clvaScreenCache?.clear();
  (globalThis as { clvaPpToken?: unknown }).clvaPpToken = null;
}

describe("readScreenNow", () => {
  beforeEach(() => {
    resetCaches();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetCaches();
  });

  it("refuses to read at all without a token, so the caller can fall back to the extension", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(readScreenNow(item())).rejects.toBeInstanceOf(NoTokenError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches the pick from one request, with no extension in the path", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(respondWith(rushingYards));

    const outcome = await readScreenNow(item());

    expect(outcome.kind).toBe("MATCHED");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://backend.propprofessor.com/screen");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(40)}`);
  });

  it("answers a second pick on the same market from cache rather than a second request", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(respondWith(rushingYards));

    await readScreenNow(item({ id: "bet-1" }));
    await readScreenNow(item({ id: "bet-2", side: "OVER" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the cache when the user asks for a refresh", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(respondWith(rushingYards));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
      await readScreenNow(item());

      // Five seconds on: still inside the cache's own TTL, so an ordinary open is served from it...
      vi.setSystemTime(new Date("2026-09-12T00:00:05Z"));
      await readScreenNow(item());
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // ...but Refresh means "ask again", and it does.
      await readScreenNow(item(), { allowCache: false });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a rejected token instead of retrying it", async () => {
    storePpToken("dead".repeat(10));
    vi.spyOn(globalThis, "fetch").mockImplementation(respondWith({ error: "expired" }, 401));

    await expect(readScreenNow(item())).rejects.toBeInstanceOf(NoTokenError);
    // Gone, so the next click falls through to the extension -- the only thing that can mint a new
    // one -- rather than spending another request on a credential already known to be dead.
    expect(getPpToken()).toBeNull();
  });

  it("does not leave a failed response in the cache", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(respondWith({ error: "oops" }, 503))
      .mockImplementation(respondWith(rushingYards));

    // The failure is thrown rather than returned: `previewNow` turns it into a READ_FAILED the
    // modal can show, and only it knows whether the extension is worth falling back to.
    await expect(readScreenNow(item())).rejects.toThrow(/503/);

    // The retry must actually retry. Caching the rejection would replay this error for the whole
    // TTL, including to the Refresh button.
    const second = await readScreenNow(item());
    expect(second.kind).toBe("MATCHED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reports a market with no PropProfessor equivalent without making a request", async () => {
    storePpToken("t".repeat(40));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = await readScreenNow(
      item({ statMarket: "Total Unicorns Ridden", sport: "NCAAF" })
    );

    expect(outcome.kind === "NO_CLOSING_MARKET" || outcome.kind === "READ_FAILED").toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
