import { authenticate, configuredClients } from "../../lib/auth.js";
import { db } from "../../lib/db.js";
import { json } from "../../lib/http.js";

/**
 * Shallow by default and unauthenticated, so uptime checks can hit it freely.
 * `?deep=1` additionally pings Postgres and reports migration state — that one
 * requires a bearer token, since it reveals internals and costs a query.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const deep = new URL(request.url).searchParams.get("deep") === "1";

  if (!deep) {
    return json({
      ok: true,
      service: "noaa-precip",
      auth_configured: configuredClients().length > 0,
      time: new Date().toISOString(),
    });
  }

  if (!authenticate(request)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const sql = db();
    const migrations = (await sql`
      SELECT filename, applied_at FROM schema_migrations ORDER BY filename
    `) as { filename: string; applied_at: string }[];
    const [{ count: zctaCount } = { count: "0" }] = (await sql`
      SELECT count(*)::text AS count FROM zcta_centroid
    `) as { count: string }[];

    return json({
      ok: true,
      service: "noaa-precip",
      database: "reachable",
      migrations: migrations.map((row) => row.filename),
      zcta_centroids: Number(zctaCount),
      clients: configuredClients(),
      time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("health deep check failed", error);
    return json(
      { ok: false, database: "unreachable", error: (error as Error).message },
      { status: 503 },
    );
  }
}
