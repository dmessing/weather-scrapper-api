import { limitDays, toDailyForecast } from "../../../lib/forecast.js";
import { ApiError, CACHE_VOLATILE, json, route } from "../../../lib/http.js";
import { resolveLocation, resolveTimezone, toLocalNaive } from "../../../lib/location.js";
import { fetchForecast } from "../../../lib/providers/nws.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 7;

/**
 * GET /api/v1/precip/forecast?zip=06107&days=7
 * GET /api/v1/precip/forecast?lat=41.75&lon=-72.74
 *
 * Served live and never persisted — a stored forecast without its issue time is
 * indistinguishable from a stale one. Cached at the CDN for an hour.
 */
export default route(async (request, client) => {
  const params = new URL(request.url).searchParams;

  const location = await resolveLocation(params);

  const daysRaw = params.get("days");
  const days = daysRaw === null ? DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new ApiError(400, "invalid_days", `days must be an integer from 1 to ${MAX_DAYS}`);
  }

  const timezone = await resolveTimezone(location, client);
  const forecast = await fetchForecast(location.lat, location.lon, client);

  // "Today" at the site, not at the server — a forecast starting yesterday is
  // not a forecast.
  const today = toLocalNaive(new Date().toISOString(), timezone).slice(0, 10);
  const daily = limitDays(
    toDailyForecast(forecast.precipitation, forecast.probability, timezone),
    days,
    today,
  );

  return json(
    {
      location: {
        zip: location.zip,
        lat: location.lat,
        lon: location.lon,
        timezone,
        key: location.key,
      },
      grain: "forecast",
      unit: "inches",
      issued_at: new Date().toISOString(),
      daily,
      // The raw interval series, for callers that need finer grain than a day.
      // NWS publishes QPF over multi-hour windows; these are passed through
      // unmodified rather than spread evenly across their hours.
      intervals: {
        precipitation: forecast.precipitation,
        probability: forecast.probability,
      },
      meta: { source: "nws", cache: "live", upstream_calls: 2 },
    },
    { maxAge: CACHE_VOLATILE },
  );
});
