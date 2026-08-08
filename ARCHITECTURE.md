# noaa-precip — architecture & build plan

A single precipitation API, deployed as Vercel functions, serving both
[`fog-light`](../fog-light) (Next.js/TS on Vercel) and
[`weather-backtest`](../weather-backtest) (`rainhedge`, Python/Streamlit on Render).

`README.txt` holds the original NOAA research spec. This document is what we're
actually building, and where it deliberately diverges.

---

## 1. Why a service and not a library

NOAA CDO's limits — 5 req/sec, 10,000 req/day — are **account-wide**, attached to the
token, not to the caller. Two independent client libraries (one npm, one pip) cannot
coordinate a shared budget: each would need its own copy of `NOAA_TOKEN`, its own token
bucket, and its own normalization logic, in two languages, with no way to know what the
other spent. A single service owns the token, the bucket, the retry policy, the ZIP→station
resolution, and the cache — and gets to attribute every upstream call to a named consumer.

The cost is one network hop. fog-light is already on Vercel so that hop is same-platform;
rainhedge does an `httpx.get` and is done. Neither app ever speaks NOAA.

A consequence worth stating: because no Python talks to NOAA, the
[`exTerEX/noaa`](https://github.com/exTerEX/noaa) library isn't part of this design. Its
CDO request/pagination shape is still a useful reference while implementing §5.1.

## 2. Where this diverges from `README.txt`

**The spec is daily-only; rainhedge needs hourly.** CDO's GHCND dataset reports daily
totals. Its hourly dataset (`PRECIP_HLY`) effectively ends in 2014, so no NOAA endpoint
can feed rainhedge's elasticity engine, which joins POS revenue against hourly
precipitation.

So this is **not** a NOAA CDO proxy. It's a precipitation API with pluggable providers
behind one contract:

| Grain | Provider | Why |
| --- | --- | --- |
| Daily history, by ZIP | NOAA CDO v2 (GHCND), ACIS fallback | Native `ZIP:#####` support; station-level truth; settlement-grade |
| Hourly history | Open-Meteo ERA5 archive | The only free source with hourly depth; already proven in `rainhedge/weather.py` |
| Real-time / forecast | NWS `api.weather.gov` | Free, no key, QPF grid; covers CDO's 24–48h reporting lag |

Both apps hit one base URL and choose a grain. Providers can be swapped without touching
either consumer.

Two smaller divergences: **Redis is dropped** (Neon serves as the cache — §4), and the
spec's `zip_rainfall_records` schema is **extended** rather than adopted verbatim (§4.2).

## 3. Decisions

| | Decision |
| --- | --- |
| Shape | Standalone Vercel service, this repo |
| Grains | Daily + hourly + forecast, unified contract |
| Storage | Neon Postgres as read-through cache, plus CDN cache headers |
| Auth | Per-consumer bearer tokens |
| rainhedge | Migrates fully — `weather.py` becomes a client of this service |
| Persisted | Daily + hourly observations; forecasts served live, not stored |
| Clients | Vendored single files, copied into each consumer |

Assumptions I made without asking, all cheap to reverse:

- **Read-through, not write-behind.** A request resolves its required date range, queries
  Neon, fetches only the gaps upstream, upserts, and returns the merged set. Steady state
  is zero NOAA calls.
- **Settled vs. unsettled days.** Observations older than the provider's reporting lag are
  immutable and never refetched. Recent days carry a `settled=false` flag and are refetched
  once their row ages past a TTL.
- **Station aggregation.** Daily responses return per-station rows *and* a ZIP-level
  aggregate. The aggregate is the mean of reporting stations (the spec's "weighted average"
  left the weights unspecified); inverse-distance weighting is a config flag, off by default.
- **Range caps.** CDO returns ≤1000 records/request and needs pagination; requests are
  capped at a range that fits within the function timeout, returning `400` beyond it.
  Long backtests page client-side.

## 4. Data layer

### 4.1 Caching strategy

Two tiers, doing different jobs:

- **Neon** is the durable cache and the thing that keeps us under quota. History
  accumulates; a multi-year backtest re-run costs zero upstream calls.
- **Vercel CDN** was intended to absorb repeat identical requests before a function even
  boots, with a long `s-maxage` on immutable settled ranges and a short one elsewhere.

  **Measured in production, this tier does not engage.** Every response returns
  `x-vercel-cache: BYPASS`, on repeats too. Vercel's Edge Network refuses to cache responses
  to requests carrying an `Authorization` header — correctly, since a shared cache must not
  serve one caller's authenticated response to another. Confirmed by comparison: identical
  requests are `BYPASS` with the header and `MISS` without it.

  The design therefore runs on one tier, and the `s-maxage` headers are currently
  decorative. This is accepted rather than worked around. The workarounds all trade away the
  security property — moving the token to a custom header would let the CDN cache, but
  Vercel would not `Vary` on that header, so an unauthenticated request could be served a
  cached response. Neon still prevents quota burn, which is the reason the service exists,
  and a Postgres round-trip on a warm instance costs tens of milliseconds.

  Revisit only if request volume makes the per-request function boot expensive; the fix
  would be a separately-routed public read path, not weaker auth.

Connection uses `@neondatabase/serverless` (HTTP driver — no pooler needed, no connection
exhaustion from concurrent function instances). `NEON_POSTGRESS_CONN_STR` is already in
`.env`; note the spelling is preserved as-is to match what's deployed.

### 4.2 Schema

```sql
-- Static ZIP centroids, seeded once from the Census ZCTA gazetteer (~33.8k rows).
-- Lives in Postgres rather than a bundled JSON file to keep the function bundle small.
CREATE TABLE zcta_centroid (
    zip        CHAR(5) PRIMARY KEY,
    lat        NUMERIC(9, 6) NOT NULL,
    lon        NUMERIC(9, 6) NOT NULL,
    state      CHAR(2)
);

-- Resolved ZIP → GHCND station mapping, so we don't re-run station discovery.
CREATE TABLE zip_station (
    zip          CHAR(5) NOT NULL,
    station_id   VARCHAR(50) NOT NULL,
    distance_mi  NUMERIC(6, 2),
    resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, station_id)
);

-- Daily observations. Extends the spec's zip_rainfall_records with source +
-- settlement tracking; natural key replaces the surrogate id.
CREATE TABLE daily_precip (
    zip              CHAR(5) NOT NULL,
    observation_date DATE NOT NULL,
    station_id       VARCHAR(50) NOT NULL,
    precip_inches    NUMERIC(6, 3),
    precip_mm        NUMERIC(7, 2),
    quality_flag     VARCHAR(10),
    source           VARCHAR(16) NOT NULL,   -- 'cdo' | 'acis'
    settled          BOOLEAN NOT NULL DEFAULT false,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, observation_date, station_id)
);
CREATE INDEX idx_daily_zip_date ON daily_precip (zip, observation_date);

-- Hourly observations. Gridded, not station-based, so keyed by ZIP + UTC hour.
-- Stored in UTC; the API converts to site-local on the way out.
CREATE TABLE hourly_precip (
    zip              CHAR(5) NOT NULL,
    observed_at_utc  TIMESTAMPTZ NOT NULL,
    precip_inches    NUMERIC(6, 3),
    source           VARCHAR(16) NOT NULL,   -- 'open-meteo'
    settled          BOOLEAN NOT NULL DEFAULT false,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, observed_at_utc, source)
);
CREATE INDEX idx_hourly_zip_time ON hourly_precip (zip, observed_at_utc);

-- Quota attribution. One row per upstream call, per consumer.
CREATE TABLE upstream_call_log (
    id          BIGSERIAL PRIMARY KEY,
    client      VARCHAR(32) NOT NULL,
    provider    VARCHAR(16) NOT NULL,
    called_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    status      INT,
    called_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calls_provider_day ON upstream_call_log (provider, called_on);
```

Migration 002 adds two tables this design originally missed:

```sql
-- Absence of a daily_precip row can't distinguish "NOAA has no observation for
-- this day" from "we never asked". Without this table every genuinely-empty day
-- looks like a cache miss forever and burns quota on every request.
CREATE TABLE daily_coverage (
    zip CHAR(5), observation_date DATE, source VARCHAR(16),
    has_data BOOLEAN, settled BOOLEAN, fetched_at TIMESTAMPTZ,
    PRIMARY KEY (zip, observation_date)
);

-- The token bucket, in Postgres so 4 req/sec holds across concurrent function
-- instances rather than per-instance.
CREATE TABLE rate_limit_bucket (
    provider VARCHAR(16) PRIMARY KEY, tokens NUMERIC(10,4), updated_at TIMESTAMPTZ
);
```

Migrations are plain numbered `.sql` files run by `npm run migrate` — no ORM.

Forecasts are deliberately absent. They're mutable, so caching them requires snapshot
versioning by issue time. If the forecast-vs-actual record becomes interesting for basis
risk, that's an append-only `forecast_snapshot` table added later; it doesn't change
anything here.

## 5. API contract

Base: `https://<deployment>/api/v1`. All responses JSON, all precipitation in **inches**
(`precip_mm` also present on daily rows). Every route requires `Authorization: Bearer <token>`.

```
GET /precip/daily?zip=06107&start=2026-01-01&end=2026-08-01[&source=auto|cdo|acis]
GET /precip/hourly?zip=06107&start=2026-01-01&end=2026-08-01
    ...or &lat=41.75&lon=-72.74 for non-US / off-ZIP sites
GET /precip/forecast?zip=06107[&days=7]
GET /health
GET /usage            -> today's upstream call count vs. the 10k ceiling, by provider
```

Shared envelope:

```jsonc
{
  "location": { "zip": "06107", "lat": 41.75, "lon": -72.74, "timezone": "America/New_York",
                "stations": [{ "id": "GHCND:US1CTHR0001", "distance_mi": 2.1 }] },
  "grain": "daily",
  "unit": "inches",
  "records": [{ "date": "2026-08-01", "precip_inches": 0.42, "station": "GHCND:US1CTHR0001",
                "quality_flag": null, "settled": true }],
  "aggregate": [{ "date": "2026-08-01", "precip_inches": 0.42, "station_count": 1 }],
  "coverage": { "expected_days": 213, "present_days": 213, "pct": 1.0 },
  "meta": { "source": "cdo", "cache": "hit", "upstream_calls": 0 }
}
```

`coverage` matters: NOAA gaps are normal, and a backtest needs to know it's reasoning over
holes rather than zeros. Missing days are **absent** from `records`, never zero-filled.

### 5.1 Provider notes

- **CDO** — `GET https://www.ncdc.noaa.gov/cdo-web/api/v2/data`, `token` header (not
  `Authorization`), `datasetid=GHCND`, `datatypeid=PRCP`, `locationid=ZIP:#####`,
  `units=standard` for inches. Paginate on `metadata.resultset.count` / `offset`, 1000/page.
  If a ZIP resolves to zero stations, fall back to a bounding-box `/stations?extent=` search
  around the ZCTA centroid (spec §5) and persist the result to `zip_station`.
- **ACIS** — `https://data.rcc-acis.org/MultiStnData`, POST JSON, no key. Fallback when CDO
  is down or a ZIP has no CDO station coverage.
- **Open-Meteo** — `archive-api.open-meteo.com/v1/archive`, `hourly=precipitation`,
  `precipitation_unit=inch`, `timezone=auto`. ERA5 lags ~5–6 days; `rainhedge/weather.py`
  already encodes this as `ARCHIVE_LAG_DAYS = 6` and that logic moves here. Recent hours
  come from the forecast endpoint's `past_days` parameter.
- **NWS** — `api.weather.gov`, requires a descriptive `User-Agent` with contact info or it
  403s. `/points/{lat},{lon}` → gridpoint → `quantitativePrecipitation`.

### 5.2 Rate limiting

Token bucket at 4 req/sec against CDO (below the 5/sec ceiling), enforced via a Postgres
counter so it holds across concurrent function instances. Exponential backoff on `429`/`503`
at `2^n × 0.5s`, max 3 retries. `upstream_call_log` drives a daily-quota check that warns at
85% of 10,000 — per the spec, but now attributable to a specific consumer.

Read-through caching means these limits should almost never bind in steady state.

## 6. Auth

```
CLIENT_TOKENS="fog-light:<32-byte hex>,rainhedge:<32-byte hex>"
```

One env var, parsed into a map at cold start. `authenticate(req)` returns the client name or
`null`; routes 401 on `null`. Comparison is `timingSafeEqual` with a length guard rather than
a map lookup, since a hash lookup on a secret leaks timing. The returned client name is the
attribution key written to `upstream_call_log`.

Rotation is additive: add the new token alongside the old, switch the consumer, drop the old.

**This authenticates services, not end users.** Every call must originate server-side — from
Next.js route handlers or server components in fog-light, never the browser. A token shipped
to a browser is a public token. If fog-light ever needs client-side precip, it proxies through
its own authenticated route.

## 7. Consumers

### fog-light
Vendored client at `src/lib/precip-client.ts` (~120 lines, zod-validated responses matching
the app's existing conventions). `PRECIP_API_URL` and `PRECIP_API_TOKEN` join the zod schema
in `src/lib/env.ts`. First real use: replacing the mocked `ForecastDay` / `RevenueWeek` data
in `src/lib/dashboard-data.ts`, which is already written as a swappable seam.

### rainhedge
Vendored client at `src/rainhedge/precip_client.py`. `weather.py`'s
`fetch_historical_precipitation(lat, lon, start, end)` keeps its signature and return shape —
a DataFrame of `timestamp` (naive site-local) and `precipitation` (inches) — so
`features.py`, `baseline.py`, and `elasticity.py` are untouched. What changes underneath: the
Open-Meteo call and the `.cache/weather` disk cache both go away, replaced by one HTTP call to
this service. `archive_max_end_date()` becomes a server-reported value rather than a local
constant. Existing tests over the fetcher become the migration's acceptance check.

## 8. Build order

1. **Skeleton** — Vercel project, TS, zod, `@neondatabase/serverless`, vitest. `authenticate()`
   + `/health`. Migration runner and the §4.2 schema. Seed `zcta_centroid` from the Census
   gazetteer.
2. ~~**Daily**~~ — done. CDO client with pagination, backoff, and token bucket; ZIP→station
   resolution with bounding-box fallback; read-through cache; `/precip/daily`. Verified
   against live NOAA: cold fetch 1 upstream call, repeat request 0, overlapping range fetches
   only the new days.
3. ~~**Hourly**~~ — done. Open-Meteo provider, UTC storage with DST-correct local rendering,
   `/precip/hourly`, addressable by ZIP *or* lat/lon. Migration 003 re-keyed `hourly_precip`
   from `zip` to a `location_key` ('zip:06107' / 'geo:41.7523,-72.7581') because rainhedge
   addresses sites by coordinate, which a CHAR(5) column cannot represent.
4. ~~**Forecast + fallback**~~ — done. NWS gridpoint QPF and probability at
   `/precip/forecast`, unpersisted and served live; ACIS wired as CDO's third fallback tier,
   narrowed to the nearest 5 stations within 15 miles so it answers the same question the
   CDO path does.
5. ~~**Clients**~~ — done. Both clients vendored; `rainhedge/weather.py` migrated onto the
   service with its public contract intact; fog-light's forecast seam built at
   `src/lib/precip-forecast.ts`. Note the existing rainhedge suite only covered
   `synthesize_precipitation`, so `tests/test_weather.py` was added to cover the fetch path
   the migration actually changed.
6. ~~**Telemetry**~~ — done. `/usage` with per-consumer attribution, the 85% warning, and
   cache-effectiveness counters. Migration 004 pins the quota day to UTC rather than
   `CURRENT_DATE`, which resolves against the session's `TimeZone` and would have filed
   calls under the wrong day if that ever changed.

All six steps are complete. What remains is deployment: this repo has no commits and is not
linked to a Vercel project, so both consumers currently point at nothing.

## 9. Open questions

- **Station weighting is now a live question, not a theoretical one.** Measured for
  West Hartford 2026-07-05: CDO's ZIP gauge 0.41" vs. 0.81" for the mean of the five
  nearest ACIS stations, with the nearest ACIS station matching CDO exactly. Decide whether
  the ZIP-level aggregate should be nearest-station, inverse-distance weighted, or the
  current unweighted mean — the answer determines what a parametric trigger actually fires on.
- **ZCTAs are not ZIPs** — confirmed during the step-1 seed: the Census 2020 gazetteer yields
  33,144 ZCTAs, while USPS issues roughly 41,000 ZIP codes. PO-box-only and single-org ZIPs
  (`00501` is the canonical example) have no ZCTA and so no centroid. This matters for the
  §5.1 fallback path, which assumes a centroid exists whenever CDO returns zero stations.
  Decide whether those ZIPs return a `422` with a clear reason or fall back to a nearest-ZCTA
  search.
- **ZCTA vintage** — Census 2020 gazetteer is current; ZCTAs shift between vintages, so the
  seeded vintage is recorded in `scripts/seed-zcta.ts` and should be surfaced in `/usage`.
- **Timezone for ZIP-based hourly** — resolved from the centroid via one Open-Meteo call per
  location and cached in `location_timezone`. Storage stays UTC: asking Open-Meteo for local
  times returns a single `utc_offset_seconds`, which cannot describe both sides of a DST
  transition, so the conversion happens on output through the IANA zone instead.
