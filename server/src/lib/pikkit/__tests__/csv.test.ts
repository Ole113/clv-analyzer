import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRows } from "../csv";

/**
 * The quoting rules, which are the only reason this parser exists.
 *
 * Splitting on commas would parse the vast majority of a Pikkit export correctly and shift the
 * columns of the handful of rows whose `bet_info` contains a comma -- so those bets end up with
 * the wrong sportsbook, stake and result while everything else looks fine. That is a failure with
 * no symptom, which is exactly what these cases are here to prevent.
 */
describe("parseCsvRows", () => {
  it("keeps commas that are inside quotes", () => {
    const rows = parseCsvRows('a,b\n1,"Hits, Runs, RBIs"\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "Hits, Runs, RBIs"],
    ]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(parseCsvRows('x\n"say ""hi"""\n')).toEqual([["x"], ['say "hi"']]);
  });

  it("keeps newlines that are inside quotes", () => {
    expect(parseCsvRows('x\n"one\ntwo"\n')).toEqual([["x"], ["one\ntwo"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsvRows("a\n1\n")).toHaveLength(2);
    expect(parseCsvRows("a\n1")).toHaveLength(2);
  });

  it("keeps an empty trailing column", () => {
    expect(parseCsvRows("a,b,c\n1,2,\n")[1]).toEqual(["1", "2", ""]);
  });

  it("strips a UTF-8 BOM so the first header name still matches", () => {
    expect(parseCsvRows("﻿bet_id,x\n1,2\n")[0][0]).toBe("bet_id");
  });
});

describe("parseCsv", () => {
  it("keys cells by header and fills missing columns with empty strings", () => {
    const [row] = parseCsv("a,b,c\n1,2\n");
    expect(row).toEqual({ a: "1", b: "2", c: "" });
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
