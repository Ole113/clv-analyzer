import { describe, expect, it } from "vitest";
import { edgeHistogram, timingBuckets } from "../analysis";

/**
 * The two bucketers, tested at their boundaries.
 *
 * Both use half-open intervals, which is the kind of rule that fails quietly: a pick counted in two
 * buckets or in neither still produces a chart that looks entirely plausible. The checks that matter
 * here are therefore conservation (every eligible pick lands in exactly one bucket) and the
 * behaviour of a value sitting exactly on an edge.
 */

const scored = (edge: number) => ({
  beatClv: edge > 0,
  edge,
  closeEvPercent: null,
  gradeResult: null,
});

describe("edge histogram", () => {
  it("puts every scored pick in exactly one bucket", () => {
    const rows = [-9, -2.5, -1.2, -0.4, 0, 0.4, 1.5, 2.5, 7].map(scored);
    const buckets = edgeHistogram(rows);
    expect(buckets.reduce((s, b) => s + b.picks, 0)).toBe(rows.length);
    expect(buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10);
  });

  it("counts a value sitting exactly on an edge in the bucket above it", () => {
    // Half-open [from, to): a flat pick belongs to "0 to 0.5", not to "-0.5 to 0". Getting this
    // backwards would file every unmoved line as a loss.
    const flat = edgeHistogram([scored(0)]);
    expect(flat.find((b) => b.key === "0 to 0.5")!.picks).toBe(1);
    expect(flat.find((b) => b.key === "-0.5 to 0")!.picks).toBe(0);
  });

  it("catches the extremes in the open-ended buckets rather than dropping them", () => {
    const buckets = edgeHistogram([scored(-40), scored(40)]);
    expect(buckets[0].picks).toBe(1);
    expect(buckets[buckets.length - 1].picks).toBe(1);
  });

  it("ignores picks with no CLV verdict instead of counting them as flat", () => {
    const buckets = edgeHistogram([
      scored(1),
      { beatClv: null, edge: null, closeEvPercent: null, gradeResult: "WIN" },
    ]);
    expect(buckets.reduce((s, b) => s + b.picks, 0)).toBe(1);
  });

  it("reports an all-zero histogram rather than throwing on an empty sample", () => {
    const buckets = edgeHistogram([]);
    expect(buckets.every((b) => b.picks === 0 && b.share === 0)).toBe(true);
  });
});

describe("timing buckets", () => {
  const kickoff = new Date("2026-09-12T16:00:00.000Z");
  const capturedHoursBefore = (hours: number, edge = 1) => ({
    ...scored(edge),
    gameStartTime: kickoff,
    openCapturedAt: new Date(kickoff.getTime() - hours * 3600_000),
  });

  it("files each pick by how long before kickoff it was taken", () => {
    const buckets = timingBuckets([
      capturedHoursBefore(0.5),
      capturedHoursBefore(2),
      capturedHoursBefore(5),
      capturedHoursBefore(12),
      capturedHoursBefore(48),
      capturedHoursBefore(200),
    ]);
    expect(buckets.map((b) => b.picks)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("puts a pick taken exactly on a boundary in the later bucket", () => {
    // Exactly 1h out is "1-3h", not "< 1h" -- the lower bound is inclusive.
    const buckets = timingBuckets([capturedHoursBefore(1)]);
    expect(buckets.find((b) => b.key === "< 1h")!.picks).toBe(0);
    expect(buckets.find((b) => b.key === "1-3h")!.picks).toBe(1);
  });

  it("leaves out picks that cannot have a lead time", () => {
    const buckets = timingBuckets([
      // No kickoff: nothing to measure against.
      { ...scored(1), gameStartTime: null, openCapturedAt: new Date() },
      // Captured after kickoff: an in-play capture, whose "lead" is negative. It must not fold
      // into the "< 1h" bucket and make late pre-kickoff picks look like whatever it did.
      capturedHoursBefore(-3),
    ]);
    expect(buckets.reduce((s, b) => s + b.picks, 0)).toBe(0);
  });

  it("averages the edge within a bucket rather than across the whole sample", () => {
    const buckets = timingBuckets([
      capturedHoursBefore(0.5, 2),
      capturedHoursBefore(0.5, 4),
      capturedHoursBefore(48, -10),
    ]);
    expect(buckets.find((b) => b.key === "< 1h")!.avgEdge).toBeCloseTo(3, 6);
    expect(buckets.find((b) => b.key === "1-3d")!.avgEdge).toBeCloseTo(-10, 6);
  });
});
