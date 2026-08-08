import { describe, expect, it } from "vitest";
import { nearestStations, normalizeAcis, parseAcisValue } from "./acis.js";

describe("parseAcisValue", () => {
  it("parses a measurement", () => {
    expect(parseAcisValue("0.42")).toBe(0.42);
    expect(parseAcisValue("0.00")).toBe(0);
  });

  it("treats a trace as zero", () => {
    // 'T' means rain fell but below the gauge's 0.01" resolution.
    expect(parseAcisValue("T")).toBe(0);
  });

  it("returns null for missing sentinels rather than a fabricated zero", () => {
    // A gap must stay a gap — 'M' is not a dry day.
    expect(parseAcisValue("M")).toBeNull();
    expect(parseAcisValue("S")).toBeNull();
    expect(parseAcisValue("")).toBeNull();
    expect(parseAcisValue(undefined)).toBeNull();
  });

  it("strips the accumulation marker", () => {
    expect(parseAcisValue("1.25A")).toBe(1.25);
  });

  it("returns null for anything unparseable", () => {
    expect(parseAcisValue("banana")).toBeNull();
  });
});

describe("normalizeAcis", () => {
  const days = ["2026-07-01", "2026-07-02", "2026-07-03"];

  it("aligns values to the requested days", () => {
    const body = {
      data: [{ meta: { sids: ["065910 1", "USC00065910 2"] }, data: [["0.10"], ["0.00"], ["0.25"]] }],
    };
    expect(normalizeAcis(body, days)).toEqual([
      { observation_date: "2026-07-01", station_id: "ACIS:065910", precip_inches: 0.1, precip_mm: 2.54, quality_flag: null },
      { observation_date: "2026-07-02", station_id: "ACIS:065910", precip_inches: 0, precip_mm: 0, quality_flag: null },
      { observation_date: "2026-07-03", station_id: "ACIS:065910", precip_inches: 0.25, precip_mm: 6.35, quality_flag: null },
    ]);
  });

  it("namespaces station ids so they cannot collide with GHCND", () => {
    const body = { data: [{ meta: { sids: ["065910 1"] }, data: [["0.10"]] }] };
    expect(normalizeAcis(body, days)[0]?.station_id).toBe("ACIS:065910");
  });

  it("skips missing days without shifting the alignment", () => {
    const body = { data: [{ meta: { sids: ["065910 1"] }, data: [["M"], ["0.30"], ["M"]] }] };
    const result = normalizeAcis(body, days);
    expect(result).toHaveLength(1);
    expect(result[0]?.observation_date).toBe("2026-07-02");
  });

  it("handles several stations", () => {
    const body = {
      data: [
        { meta: { sids: ["A 1"] }, data: [["0.10"], ["M"], ["M"]] },
        { meta: { sids: ["B 1"] }, data: [["0.20"], ["M"], ["M"]] },
      ],
    };
    expect(normalizeAcis(body, days).map((r) => r.station_id)).toEqual(["ACIS:A", "ACIS:B"]);
  });

  it("tolerates an empty or malformed payload", () => {
    expect(normalizeAcis({}, days)).toEqual([]);
    expect(normalizeAcis({ data: [] }, days)).toEqual([]);
    expect(normalizeAcis({ data: [{ meta: {}, data: [] }] }, days)).toEqual([]);
  });
});

describe("nearestStations", () => {
  const centroid = { lat: 41.7523, lon: -72.7581 }; // West Hartford CT
  const at = (lat: number, lon: number, id: string) => ({
    meta: { sids: [`${id} 1`], ll: [lon, lat] as [number, number] },
  });

  it("keeps the nearest stations in distance order", () => {
    const far = at(41.95, -72.68, "far"); // ~14 mi
    const near = at(41.7530, -72.7590, "near"); // ~0.1 mi
    const mid = at(41.80, -72.80, "mid"); // ~4 mi
    const result = nearestStations([far, near, mid], centroid);
    expect(result.map((s) => s.meta.sids[0])).toEqual(["near 1", "mid 1", "far 1"]);
  });

  it("drops stations beyond the keep radius", () => {
    // Boston is ~90 miles away and must not contribute to a Hartford average.
    const boston = at(42.3601, -71.0589, "boston");
    const local = at(41.7530, -72.7590, "local");
    expect(nearestStations([boston, local], centroid)).toHaveLength(1);
  });

  it("caps the station count", () => {
    const many = Array.from({ length: 20 }, (_, i) => at(41.75 + i * 0.001, -72.758, `s${i}`));
    expect(nearestStations(many, centroid)).toHaveLength(5);
  });

  it("drops stations with no coordinates rather than assuming they are nearby", () => {
    const noLl: { meta: { sids: string[]; ll?: [number, number] } } = {
      meta: { sids: ["x 1"] },
    };
    expect(nearestStations([noLl], centroid)).toEqual([]);
  });

  it("returns nothing when every station is out of range", () => {
    expect(nearestStations([at(0, 0, "null-island")], centroid)).toEqual([]);
  });
});
