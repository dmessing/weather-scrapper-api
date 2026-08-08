import { describe, expect, it } from "vitest";
import { normalizeSeries, parseValidTime } from "./nws.js";

describe("parseValidTime", () => {
  it("splits an instant and an hour duration", () => {
    expect(parseValidTime("2026-08-08T18:00:00+00:00/PT6H")).toEqual({
      start: "2026-08-08T18:00:00.000Z",
      hours: 6,
    });
  });

  it("normalises a non-UTC offset to UTC", () => {
    expect(parseValidTime("2026-08-08T14:00:00-04:00/PT1H")?.start).toBe(
      "2026-08-08T18:00:00.000Z",
    );
  });

  it("handles day and combined durations", () => {
    expect(parseValidTime("2026-08-08T00:00:00+00:00/P1D")?.hours).toBe(24);
    expect(parseValidTime("2026-08-08T00:00:00+00:00/P1DT2H")?.hours).toBe(26);
    expect(parseValidTime("2026-08-08T00:00:00+00:00/PT30M")?.hours).toBe(0.5);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(parseValidTime("2026-08-08T18:00:00+00:00")).toBeNull();
    expect(parseValidTime("not-a-time/PT1H")).toBeNull();
    expect(parseValidTime("2026-08-08T18:00:00+00:00/PT0H")).toBeNull();
    expect(parseValidTime("2026-08-08T18:00:00+00:00/banana")).toBeNull();
  });
});

describe("normalizeSeries", () => {
  const mmSeries = {
    uom: "wmoUnit:mm",
    values: [
      { validTime: "2026-08-08T18:00:00+00:00/PT6H", value: 25.4 },
      { validTime: "2026-08-09T00:00:00+00:00/PT6H", value: 0 },
    ],
  };

  it("converts millimetres to inches", () => {
    const [first] = normalizeSeries(mmSeries, { convertToInches: true });
    expect(first?.value).toBe(1);
    expect(first?.hours).toBe(6);
    expect(first?.valid_to).toBe("2026-08-09T00:00:00.000Z");
  });

  it("leaves percentages alone", () => {
    const series = {
      uom: "wmoUnit:percent",
      values: [{ validTime: "2026-08-08T18:00:00+00:00/PT6H", value: 40 }],
    };
    expect(normalizeSeries(series, { convertToInches: false })[0]?.value).toBe(40);
  });

  it("does not convert when the unit is not mm, even if asked", () => {
    const series = {
      uom: "wmoUnit:in",
      values: [{ validTime: "2026-08-08T18:00:00+00:00/PT6H", value: 2 }],
    };
    expect(normalizeSeries(series, { convertToInches: true })[0]?.value).toBe(2);
  });

  it("drops null values but keeps genuine zeros", () => {
    const series = {
      uom: "wmoUnit:mm",
      values: [
        { validTime: "2026-08-08T18:00:00+00:00/PT6H", value: null },
        { validTime: "2026-08-09T00:00:00+00:00/PT6H", value: 0 },
      ],
    };
    const result = normalizeSeries(series, { convertToInches: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe(0);
  });

  it("skips entries with an unparseable validTime", () => {
    const series = {
      uom: "wmoUnit:mm",
      values: [{ validTime: "garbage", value: 5 }],
    };
    expect(normalizeSeries(series, { convertToInches: true })).toEqual([]);
  });

  it("tolerates an absent series", () => {
    expect(normalizeSeries(undefined, { convertToInches: true })).toEqual([]);
    expect(normalizeSeries({}, { convertToInches: true })).toEqual([]);
  });
});
