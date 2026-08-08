import { describe, expect, it } from "vitest";
import { aggregateByDate, contiguousRanges, missingDays, type DailyRecord } from "./daily.js";

const record = (date: string, station: string, inches: number): DailyRecord => ({
  date,
  station,
  precip_inches: inches,
  precip_mm: Number((inches * 25.4).toFixed(2)),
  quality_flag: null,
  settled: true,
});

describe("contiguousRanges", () => {
  it("collapses consecutive days into one range", () => {
    expect(contiguousRanges(["2026-08-01", "2026-08-02", "2026-08-03"])).toEqual([
      { start: "2026-08-01", end: "2026-08-03" },
    ]);
  });

  it("splits on a gap", () => {
    expect(
      contiguousRanges(["2026-08-01", "2026-08-02", "2026-08-05", "2026-08-06"]),
    ).toEqual([
      { start: "2026-08-01", end: "2026-08-02" },
      { start: "2026-08-05", end: "2026-08-06" },
    ]);
  });

  it("spans a month boundary without splitting", () => {
    expect(contiguousRanges(["2026-07-31", "2026-08-01"])).toEqual([
      { start: "2026-07-31", end: "2026-08-01" },
    ]);
  });

  it("sorts unordered input", () => {
    expect(contiguousRanges(["2026-08-03", "2026-08-01", "2026-08-02"])).toEqual([
      { start: "2026-08-01", end: "2026-08-03" },
    ]);
  });

  it("handles one day and none", () => {
    expect(contiguousRanges(["2026-08-01"])).toEqual([
      { start: "2026-08-01", end: "2026-08-01" },
    ]);
    expect(contiguousRanges([])).toEqual([]);
  });
});

describe("missingDays", () => {
  const range = ["2026-08-01", "2026-08-02", "2026-08-03"];

  it("returns everything when nothing is cached", () => {
    expect(missingDays(range, [])).toEqual(range);
  });

  it("skips settled days", () => {
    const coverage = [{ observation_date: "2026-08-02", settled: true }];
    expect(missingDays(range, coverage)).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("refetches unsettled days even though they are cached", () => {
    // A day inside the reporting lag may still gain observations.
    const coverage = [{ observation_date: "2026-08-02", settled: false }];
    expect(missingDays(range, coverage)).toEqual(range);
  });

  it("treats a settled empty day as covered", () => {
    // has_data=false but settled — NOAA genuinely has nothing. Must not refetch.
    const coverage = range.map((day) => ({ observation_date: day, settled: true }));
    expect(missingDays(range, coverage)).toEqual([]);
  });
});

describe("aggregateByDate", () => {
  it("averages across stations and counts them", () => {
    expect(
      aggregateByDate([
        record("2026-08-01", "A", 0.4),
        record("2026-08-01", "B", 0.6),
        record("2026-08-02", "A", 0),
      ]),
    ).toEqual([
      { date: "2026-08-01", precip_inches: 0.5, station_count: 2 },
      { date: "2026-08-02", precip_inches: 0, station_count: 1 },
    ]);
  });

  it("sorts by date regardless of input order", () => {
    const result = aggregateByDate([record("2026-08-03", "A", 1), record("2026-08-01", "A", 2)]);
    expect(result.map((row) => row.date)).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("omits dates entirely rather than zero-filling", () => {
    expect(aggregateByDate([])).toEqual([]);
  });
});
