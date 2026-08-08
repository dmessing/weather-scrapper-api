import { describe, expect, it } from "vitest";
import { limitDays, toDailyForecast } from "./forecast.js";
import type { ForecastInterval } from "./providers/nws.js";

const NY = "America/New_York";

const interval = (from: string, hours: number, value: number): ForecastInterval => ({
  valid_from: from,
  valid_to: new Date(Date.parse(from) + hours * 3_600_000).toISOString(),
  hours,
  value,
});

describe("toDailyForecast", () => {
  it("sums depth and maxes probability within a local day", () => {
    const precipitation = [
      interval("2026-08-08T10:00:00Z", 6, 0.2), // 06:00 EDT
      interval("2026-08-08T16:00:00Z", 6, 0.3), // 12:00 EDT
    ];
    const probability = [
      interval("2026-08-08T10:00:00Z", 6, 40),
      interval("2026-08-08T16:00:00Z", 6, 70),
    ];

    expect(toDailyForecast(precipitation, probability, NY)).toEqual([
      { date: "2026-08-08", precip_inches: 0.5, max_probability_percent: 70 },
    ]);
  });

  it("does not add probabilities together", () => {
    // Two 40% windows are not an 80% day.
    const probability = [
      interval("2026-08-08T10:00:00Z", 6, 40),
      interval("2026-08-08T16:00:00Z", 6, 40),
    ];
    expect(toDailyForecast([], probability, NY)[0]?.max_probability_percent).toBe(40);
  });

  it("buckets by local day, not UTC day", () => {
    // 02:00Z on the 9th is still 22:00 on the 8th in New York.
    const precipitation = [interval("2026-08-09T02:00:00Z", 1, 0.1)];
    expect(toDailyForecast(precipitation, [], NY)[0]?.date).toBe("2026-08-08");
  });

  it("attributes a straddling interval to the day it starts in", () => {
    const precipitation = [interval("2026-08-08T22:00:00Z", 6, 0.6)]; // 18:00 EDT -> 00:00
    const result = toDailyForecast(precipitation, [], NY);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-08-08");
  });

  it("reports a day with probability but no forecast depth", () => {
    const result = toDailyForecast([], [interval("2026-08-08T16:00:00Z", 6, 20)], NY);
    expect(result).toEqual([
      { date: "2026-08-08", precip_inches: 0, max_probability_percent: 20 },
    ]);
  });

  it("returns null probability when the series is absent", () => {
    const result = toDailyForecast([interval("2026-08-08T16:00:00Z", 6, 0.1)], [], NY);
    expect(result[0]?.max_probability_percent).toBeNull();
  });

  it("sorts days ascending", () => {
    const precipitation = [
      interval("2026-08-10T16:00:00Z", 6, 0.1),
      interval("2026-08-08T16:00:00Z", 6, 0.2),
    ];
    expect(toDailyForecast(precipitation, [], NY).map((d) => d.date)).toEqual([
      "2026-08-08",
      "2026-08-10",
    ]);
  });

  it("is empty for an empty forecast", () => {
    expect(toDailyForecast([], [], NY)).toEqual([]);
  });
});

describe("limitDays", () => {
  const week = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-08-0${index + 1}`,
    precip_inches: 0,
    max_probability_percent: null,
  }));

  it("trims to the requested count", () => {
    expect(limitDays(week, 3)).toHaveLength(3);
  });

  it("returns everything when asked for more than exists", () => {
    expect(limitDays(week, 30)).toHaveLength(7);
  });

  it("never returns an empty list for a nonsense count", () => {
    expect(limitDays(week, 0)).toHaveLength(1);
  });

  it("drops days before the start date", () => {
    // The NWS series opens before the current hour, so its first bucket is
    // usually yesterday in local time.
    const result = limitDays(week, 7, "2026-08-03");
    expect(result[0]?.date).toBe("2026-08-03");
    expect(result).toHaveLength(5);
  });

  it("still returns the requested count when earlier days are dropped", () => {
    expect(limitDays(week, 3, "2026-08-02")).toHaveLength(3);
    expect(limitDays(week, 3, "2026-08-02")[0]?.date).toBe("2026-08-02");
  });

  it("is unchanged when no start date is given", () => {
    expect(limitDays(week, 7)).toHaveLength(7);
  });
});
