import { describe, expect, it } from "vitest";
import { normalizeHourly, toUtcIso } from "./openmeteo.js";

describe("toUtcIso", () => {
  it("stamps Open-Meteo's zoneless timestamp as UTC", () => {
    expect(toUtcIso("2026-07-01T00:00")).toBe("2026-07-01T00:00:00Z");
    expect(toUtcIso("2026-07-01T13:45")).toBe("2026-07-01T13:45:00Z");
  });

  it("leaves an already-stamped timestamp alone", () => {
    expect(toUtcIso("2026-07-01T00:00:00Z")).toBe("2026-07-01T00:00:00Z");
  });

  it("produces something Date can parse", () => {
    expect(new Date(toUtcIso("2026-07-01T05:00")).toISOString()).toBe(
      "2026-07-01T05:00:00.000Z",
    );
  });
});

describe("normalizeHourly", () => {
  it("zips the parallel arrays", () => {
    expect(
      normalizeHourly({
        time: ["2026-07-01T00:00", "2026-07-01T01:00"],
        precipitation: [0, 0.04],
      }),
    ).toEqual([
      { observed_at_utc: "2026-07-01T00:00:00Z", precip_inches: 0 },
      { observed_at_utc: "2026-07-01T01:00:00Z", precip_inches: 0.04 },
    ]);
  });

  it("drops null hours rather than treating them as dry", () => {
    // A null is a hole in ERA5, not zero rainfall.
    const result = normalizeHourly({
      time: ["2026-07-01T00:00", "2026-07-01T01:00", "2026-07-01T02:00"],
      precipitation: [0.1, null, 0.2],
    });
    expect(result.map((r) => r.observed_at_utc)).toEqual([
      "2026-07-01T00:00:00Z",
      "2026-07-01T02:00:00Z",
    ]);
  });

  it("keeps a genuine zero", () => {
    expect(normalizeHourly({ time: ["2026-07-01T00:00"], precipitation: [0] })).toHaveLength(1);
  });

  it("tolerates a missing or empty payload", () => {
    expect(normalizeHourly(undefined)).toEqual([]);
    expect(normalizeHourly({})).toEqual([]);
    expect(normalizeHourly({ time: [], precipitation: [] })).toEqual([]);
  });

  it("ignores times with no matching value", () => {
    expect(
      normalizeHourly({ time: ["2026-07-01T00:00", "2026-07-01T01:00"], precipitation: [0.1] }),
    ).toHaveLength(1);
  });
});
