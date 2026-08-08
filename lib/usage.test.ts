import { describe, expect, it } from "vitest";
import { summarizeQuota } from "./usage.js";

describe("summarizeQuota", () => {
  it("reports remaining and percentage against a published ceiling", () => {
    expect(summarizeQuota("cdo", 2_500, 0, 0, 10_000)).toEqual({
      provider: "cdo",
      used: 2_500,
      errors: 0,
      rejected: 0,
      quota: 10_000,
      remaining: 7_500,
      pct_used: 0.25,
      warn: false,
      exhausted: false,
    });
  });

  it("warns at exactly 85%", () => {
    expect(summarizeQuota("cdo", 8_500, 0, 0, 10_000).warn).toBe(true);
    expect(summarizeQuota("cdo", 8_499, 0, 0, 10_000).warn).toBe(false);
  });

  it("marks exhaustion at the ceiling, not past it", () => {
    expect(summarizeQuota("cdo", 10_000, 0, 0, 10_000).exhausted).toBe(true);
    expect(summarizeQuota("cdo", 9_999, 0, 0, 10_000).exhausted).toBe(false);
  });

  it("still warns once exhausted", () => {
    const summary = summarizeQuota("cdo", 12_000, 0, 0, 10_000);
    expect(summary.warn).toBe(true);
    expect(summary.exhausted).toBe(true);
  });

  it("never reports negative remaining", () => {
    // Concurrent instances can overshoot the ceiling slightly.
    expect(summarizeQuota("cdo", 10_050, 0, 0, 10_000).remaining).toBe(0);
  });

  it("omits the percentage when the provider publishes no ceiling", () => {
    // A made-up denominator would be worse than none.
    const summary = summarizeQuota("open-meteo", 400, 0, 0, undefined);
    expect(summary.quota).toBeNull();
    expect(summary.pct_used).toBeNull();
    expect(summary.remaining).toBeNull();
    expect(summary.warn).toBe(false);
    expect(summary.used).toBe(400);
  });

  it("separates provider failures from input-driven refusals", () => {
    // A 404 for a point outside NWS coverage is not the provider failing.
    const summary = summarizeQuota("nws", 10, 0, 2, undefined);
    expect(summary.errors).toBe(0);
    expect(summary.rejected).toBe(2);
  });

  it("carries the error count through", () => {
    expect(summarizeQuota("nws", 10, 3, 0, undefined).errors).toBe(3);
  });

  it("handles a provider with no calls today", () => {
    const summary = summarizeQuota("acis", 0, 0, 0, undefined);
    expect(summary.used).toBe(0);
    expect(summary.warn).toBe(false);
  });
});
