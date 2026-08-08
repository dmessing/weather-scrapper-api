import { daysBetween, parseDate } from "../../../lib/dates.js";
import { getHourly } from "../../../lib/hourly.js";
import { ApiError, CACHE_SETTLED, CACHE_VOLATILE, json, route } from "../../../lib/http.js";
import { resolveLocation } from "../../../lib/location.js";

/** Matches the daily endpoint's cap so both grains page identically. */
const MAX_RANGE_DAYS = 366;

/**
 * GET /api/v1/precip/hourly?zip=06107&start=2026-07-01&end=2026-07-07
 * GET /api/v1/precip/hourly?lat=41.75&lon=-72.74&start=...&end=...
 *
 * `records` carry both a naive site-local timestamp and the UTC instant. The
 * local one is what rainhedge joins POS receipts against; the UTC one is what
 * makes the series unambiguous across a DST transition.
 */
export default route(async (request, client) => {
  const params = new URL(request.url).searchParams;

  const location = await resolveLocation(params);
  const start = parseDate(params.get("start"), "start");
  const end = parseDate(params.get("end"), "end");
  if (end < start) {
    throw new ApiError(400, "invalid_range", "end must be on or after start");
  }

  const span = daysBetween(start, end);
  if (span > MAX_RANGE_DAYS) {
    throw new ApiError(400, "range_too_long", {
      requested_days: span,
      max_days: MAX_RANGE_DAYS,
      reason: "Page client-side; hourly responses grow at 24 records per day.",
    });
  }

  const result = await getHourly(location, start, end, client);

  return json(
    {
      location: {
        zip: location.zip,
        lat: location.lat,
        lon: location.lon,
        timezone: result.timezone,
        key: location.key,
      },
      grain: "hourly",
      unit: "inches",
      range: { start, end },
      // ERA5 lags real time. Surfaced so callers can clamp a request window
      // instead of hard-coding a lag constant of their own.
      archive_max_end_date: result.archive_max_end_date,
      records: result.records,
      coverage: result.coverage,
      meta: result.meta,
    },
    { maxAge: result.fully_settled ? CACHE_SETTLED : CACHE_VOLATILE },
  );
});
