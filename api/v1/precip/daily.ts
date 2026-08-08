import { getDaily } from "../../../lib/daily.js";
import { daysBetween, parseDate } from "../../../lib/dates.js";
import { ApiError, CACHE_SETTLED, CACHE_VOLATILE, json, route } from "../../../lib/http.js";
import { CDO_MAX_RANGE_DAYS } from "../../../lib/providers/cdo.js";
import { getCentroid } from "../../../lib/stations.js";

/**
 * GET /api/v1/precip/daily?zip=06107&start=2026-01-01&end=2026-08-01
 *
 * Missing days are absent from `records`, never zero-filled — a backtest needs
 * to know it is reasoning over holes rather than over dry days.
 */
export default route(async (request, client) => {
  const params = new URL(request.url).searchParams;

  const zip = params.get("zip")?.trim() ?? "";
  if (!/^\d{5}$/.test(zip)) {
    throw new ApiError(400, "invalid_zip", "zip must be 5 digits");
  }

  const start = parseDate(params.get("start"), "start");
  const end = parseDate(params.get("end"), "end");
  if (end < start) {
    throw new ApiError(400, "invalid_range", "end must be on or after start");
  }

  const span = daysBetween(start, end);
  if (span > CDO_MAX_RANGE_DAYS) {
    throw new ApiError(400, "range_too_long", {
      requested_days: span,
      max_days: CDO_MAX_RANGE_DAYS,
      reason: "CDO rejects a data request spanning more than one year; page client-side.",
    });
  }

  const result = await getDaily(zip, start, end, client);
  const centroid = await getCentroid(zip);

  return json(
    {
      location: {
        zip,
        lat: centroid?.lat ?? null,
        lon: centroid?.lon ?? null,
        stations: result.stations,
      },
      grain: "daily",
      unit: "inches",
      range: { start, end },
      records: result.records,
      aggregate: result.aggregate,
      coverage: result.coverage,
      meta: result.meta,
    },
    // Settled history is immutable, so it can cache effectively forever. A range
    // touching the reporting lag must not.
    { maxAge: result.fully_settled ? CACHE_SETTLED : CACHE_VOLATILE },
  );
});
