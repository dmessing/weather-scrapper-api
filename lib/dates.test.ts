import { describe, expect, it } from "vitest";
import { addDays, daysBetween, eachDay, parseDate, settledCutoff, toIsoDate } from "./dates.js";
import { ApiError } from "./http.js";

/** ApiError.message is the machine code; the human explanation is in `detail`. */
function thrownBy(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("parseDate", () => {
  it("accepts a real date", () => {
    expect(parseDate("2026-08-01", "start")).toBe("2026-08-01");
  });

  it("rejects a rolled-over date", () => {
    // Date.parse happily turns this into March 3rd; the round-trip guard catches it.
    const error = thrownBy(() => parseDate("2026-02-31", "start"));
    expect(error.status).toBe(400);
    expect(error.message).toBe("invalid_date");
    expect(error.detail).toMatch(/not a real date/);
  });

  it("rejects malformed input", () => {
    for (const bad of [null, "", "2026-8-1", "08/01/2026", "yesterday"]) {
      const error = thrownBy(() => parseDate(bad, "start"));
      expect(error.status).toBe(400);
      expect(error.detail).toMatch(/YYYY-MM-DD/);
    }
  });

  it("names the offending field in the detail", () => {
    expect(thrownBy(() => parseDate("nope", "end")).detail).toMatch(/^end /);
  });
});

describe("date arithmetic", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("counts days inclusively", () => {
    expect(daysBetween("2026-08-01", "2026-08-01")).toBe(1);
    expect(daysBetween("2026-08-01", "2026-08-07")).toBe(7);
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(365);
  });

  it("does not drift across a DST transition", () => {
    // US DST starts 2026-03-08. UTC-based arithmetic must not lose an hour.
    expect(eachDay("2026-03-07", "2026-03-09")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("enumerates a single day", () => {
    expect(eachDay("2026-08-01", "2026-08-01")).toEqual(["2026-08-01"]);
  });
});

describe("settledCutoff", () => {
  it("backs off the lag from today", () => {
    expect(settledCutoff(3, new Date("2026-08-08T12:00:00Z"))).toBe("2026-08-05");
  });

  it("agrees with toIsoDate at zero lag", () => {
    const today = new Date("2026-08-08T23:59:00Z");
    expect(settledCutoff(0, today)).toBe(toIsoDate(today));
  });
});
