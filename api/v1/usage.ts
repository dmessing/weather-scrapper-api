import { json, route } from "../../lib/http.js";
import { buildUsageReport } from "../../lib/usage.js";

/**
 * GET /api/v1/usage
 *
 * What the shared NOAA budget has been spent on today, by which consumer, and
 * how much of the work the cache absorbed. Never cached — a stale quota reading
 * is worse than no reading.
 */
export default route(async () => {
  const report = await buildUsageReport();
  return json(report);
});
