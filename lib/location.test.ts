import { describe, expect, it } from "vitest";
import { geoKey, localHoursInRange, localMidnightUtc, toLocalNaive, zipKey } from "./location.js";

describe("cache keys", () => {
  it("rounds coordinates to 4dp", () => {
    expect(geoKey(41.752304, -72.758098)).toBe("geo:41.7523,-72.7581");
  });

  it("keeps a zip's leading zero", () => {
    expect(zipKey("06107")).toBe("zip:06107");
  });

  it("fits the location_key column", () => {
    expect(geoKey(-89.123456, -179.987654).length).toBeLessThanOrEqual(32);
  });
});

describe("toLocalNaive", () => {
  const NY = "America/New_York";

  it("converts a UTC instant to naive local", () => {
    // 16:00Z in July is 12:00 EDT.
    expect(toLocalNaive("2026-07-01T16:00:00Z", NY)).toBe("2026-07-01T12:00:00");
  });

  it("applies the correct offset on each side of a DST transition", () => {
    // US DST began 2026-03-08 at 07:00Z. EST is -5, EDT is -4.
    expect(toLocalNaive("2026-03-08T06:00:00Z", NY)).toBe("2026-03-08T01:00:00");
    expect(toLocalNaive("2026-03-08T08:00:00Z", NY)).toBe("2026-03-08T04:00:00");
  });

  it("rolls the date backwards when local time is the previous day", () => {
    // 02:00Z is still 22:00 the previous evening in New York.
    expect(toLocalNaive("2026-07-02T02:00:00Z", NY)).toBe("2026-07-01T22:00:00");
  });

  it("renders local midnight as 00, not 24", () => {
    expect(toLocalNaive("2026-07-01T04:00:00Z", NY)).toBe("2026-07-01T00:00:00");
  });

  it("is the identity for UTC", () => {
    expect(toLocalNaive("2026-07-01T13:45:00Z", "UTC")).toBe("2026-07-01T13:45:00");
  });
});

describe("localMidnightUtc", () => {
  const NY = "America/New_York";

  it("finds local midnight in UTC on a normal day", () => {
    // Midnight EDT on July 5th is 04:00Z.
    expect(localMidnightUtc("2026-07-05", NY).toISOString()).toBe("2026-07-05T04:00:00.000Z");
  });

  it("uses the winter offset in winter", () => {
    // Midnight EST on Jan 5th is 05:00Z.
    expect(localMidnightUtc("2026-01-05", NY).toISOString()).toBe("2026-01-05T05:00:00.000Z");
  });

  it("resolves midnight on the spring-forward day itself", () => {
    // The transition is at 02:00 local, so midnight is still EST (-5).
    expect(localMidnightUtc("2026-03-08", NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("is a no-op for UTC", () => {
    expect(localMidnightUtc("2026-07-05", "UTC").toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });
});

describe("localHoursInRange", () => {
  const NY = "America/New_York";

  it("counts 24 hours for an ordinary day", () => {
    expect(localHoursInRange("2026-07-05", "2026-07-05", NY)).toBe(24);
    expect(localHoursInRange("2026-07-05", "2026-07-07", NY)).toBe(72);
  });

  it("counts 23 hours across spring-forward", () => {
    // The clocks jump 02:00 -> 03:00, so the day is an hour short. Reporting 24
    // would make a complete series look like it had a hole.
    expect(localHoursInRange("2026-03-08", "2026-03-08", NY)).toBe(23);
    expect(localHoursInRange("2026-03-07", "2026-03-09", NY)).toBe(71);
  });

  it("counts 25 hours across fall-back", () => {
    // 2026-11-01: clocks go back, the 01:00 hour happens twice.
    expect(localHoursInRange("2026-11-01", "2026-11-01", NY)).toBe(25);
  });

  it("is unaffected by DST in a zone that has none", () => {
    expect(localHoursInRange("2026-03-07", "2026-03-09", "America/Phoenix")).toBe(72);
  });
});
