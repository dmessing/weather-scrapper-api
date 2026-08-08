-- 003: hourly precipitation, keyed by location rather than ZIP.
--
-- rainhedge addresses sites by lat/lon, not ZIP — a car wash is at a point, and
-- some sites have no usable ZIP. The 001 definition of hourly_precip keyed on
-- CHAR(5) zip, which cannot represent that. The table is empty (verified before
-- writing this migration), so it is redefined rather than migrated.
--
-- location_key is 'zip:06107' or 'geo:41.7523,-72.7581' (4dp, ~11m). Both
-- resolve to the same storage shape, so a ZIP request and a coordinate request
-- for the same place share a cache entry only when they round to the same key —
-- which is the honest behaviour, since they are different points.

DROP TABLE IF EXISTS hourly_precip;

CREATE TABLE hourly_precip (
    location_key    VARCHAR(32) NOT NULL,
    observed_at_utc TIMESTAMPTZ NOT NULL,
    precip_inches   NUMERIC(6, 3),
    source          VARCHAR(16) NOT NULL,
    settled         BOOLEAN NOT NULL DEFAULT false,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_key, observed_at_utc, source)
);

CREATE INDEX IF NOT EXISTS idx_hourly_location_time
    ON hourly_precip (location_key, observed_at_utc);

-- Same "did we already ask?" problem as daily_coverage, at day granularity:
-- an hourly fetch always covers whole days, so tracking per-hour would be 24x
-- the rows for no extra information.
CREATE TABLE IF NOT EXISTS hourly_coverage (
    location_key     VARCHAR(32) NOT NULL,
    observation_date DATE NOT NULL,
    source           VARCHAR(16) NOT NULL,
    has_data         BOOLEAN NOT NULL DEFAULT false,
    settled          BOOLEAN NOT NULL DEFAULT false,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_key, observation_date)
);

-- IANA timezone name for a location, learned once from Open-Meteo and cached.
-- Needed to render UTC storage back into the naive site-local timestamps that
-- rainhedge's feature pipeline expects.
CREATE TABLE IF NOT EXISTS location_timezone (
    location_key VARCHAR(32) PRIMARY KEY,
    timezone     VARCHAR(64) NOT NULL,
    resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
