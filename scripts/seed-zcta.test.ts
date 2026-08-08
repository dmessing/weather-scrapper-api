import { describe, expect, it } from "vitest";
import { parseGazetteer } from "./seed-zcta.js";

// Real gazetteer rows: tab-separated, padded headers, trailing whitespace.
const SAMPLE = [
  "GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\t   INTPTLONG   ",
  "06107\t14209194\t60830\t5.486\t0.023\t41.752823\t-72.756393",
  "00501\t0\t0\t0.000\t0.000\t40.813505\t-73.046921",
].join("\n");

describe("parseGazetteer", () => {
  it("parses ZIP and centroid, tolerating padded headers", () => {
    expect(parseGazetteer(SAMPLE)).toEqual([
      { zip: "06107", lat: 41.752823, lon: -72.756393 },
      { zip: "00501", lat: 40.813505, lon: -73.046921 },
    ]);
  });

  it("preserves the leading zero in a ZIP", () => {
    expect(parseGazetteer(SAMPLE)[0]?.zip).toBe("06107");
  });

  it("skips rows with a malformed ZIP or non-numeric centroid", () => {
    const source = [
      "GEOID\tINTPTLAT\tINTPTLONG",
      "6107\t41.75\t-72.75", // 4 digits
      "ABCDE\t41.75\t-72.75",
      "06108\tnot-a-number\t-72.75",
      "06109\t41.75\t-72.75",
    ].join("\n");
    expect(parseGazetteer(source)).toEqual([
      { zip: "06109", lat: 41.75, lon: -72.75 },
    ]);
  });

  it("throws when the expected columns are absent", () => {
    expect(() => parseGazetteer("FOO\tBAR\nx\ty")).toThrow(/Unexpected gazetteer columns/);
  });

  it("throws on an empty file", () => {
    expect(() => parseGazetteer("")).toThrow(/empty/);
  });
});
