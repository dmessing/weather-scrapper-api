import { describe, expect, it } from "vitest";
import { normalize, qualityFlag, type CdoResult } from "./cdo.js";

const result = (over: Partial<CdoResult> = {}): CdoResult => ({
  date: "2026-08-01T00:00:00",
  datatype: "PRCP",
  station: "GHCND:US1CTHR0001",
  attributes: ",,N,",
  value: 0.42,
  ...over,
});

describe("qualityFlag", () => {
  it("reads the second of the four packed flags", () => {
    expect(qualityFlag(",,N,")).toBeNull();
    expect(qualityFlag(",I,N,")).toBe("I");
    expect(qualityFlag("T,S,N,0800")).toBe("S");
  });

  it("treats absent attributes as unflagged", () => {
    expect(qualityFlag(undefined)).toBeNull();
    expect(qualityFlag("")).toBeNull();
  });
});

describe("normalize", () => {
  it("converts a CDO row to storage shape", () => {
    expect(normalize([result()])).toEqual([
      {
        observation_date: "2026-08-01",
        station_id: "GHCND:US1CTHR0001",
        precip_inches: 0.42,
        precip_mm: 10.67,
        quality_flag: null,
      },
    ]);
  });

  it("strips the time component from the date", () => {
    expect(normalize([result()])[0]?.observation_date).toBe("2026-08-01");
  });

  it("drops rows that failed NOAA's own QC", () => {
    // A wrong number that looks real is worse than a gap.
    expect(normalize([result({ attributes: ",I,N," })])).toEqual([]);
  });

  it("drops non-PRCP datatypes and non-finite values", () => {
    expect(normalize([result({ datatype: "SNOW" })])).toEqual([]);
    expect(normalize([result({ value: Number.NaN })])).toEqual([]);
  });

  it("keeps a genuine zero", () => {
    // 0.0 is a real observation — a dry day — not a missing one.
    const [row] = normalize([result({ value: 0 })]);
    expect(row?.precip_inches).toBe(0);
    expect(row?.precip_mm).toBe(0);
  });

  it("returns nothing for an empty result set", () => {
    expect(normalize([])).toEqual([]);
  });
});
