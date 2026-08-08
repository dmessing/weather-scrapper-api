-- 001_init: ZIP resolution, observation cache, and quota attribution.
-- Schema rationale lives in ARCHITECTURE.md §4.2.

-- Static ZIP centroids, seeded from the Census 2020 ZCTA gazetteer (~33.8k rows).
-- Kept in Postgres rather than bundled as JSON so the function bundle stays small.
CREATE TABLE IF NOT EXISTS zcta_centroid (
    zip   CHAR(5) PRIMARY KEY,
    lat   NUMERIC(9, 6) NOT NULL,
    lon   NUMERIC(9, 6) NOT NULL,
    state CHAR(2)
);

-- Resolved ZIP -> GHCND station mapping, so station discovery runs once per ZIP.
CREATE TABLE IF NOT EXISTS zip_station (
    zip         CHAR(5) NOT NULL,
    station_id  VARCHAR(50) NOT NULL,
    distance_mi NUMERIC(6, 2),
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, station_id)
);

-- Daily observations, per station. `settled` distinguishes immutable history
-- from days still inside the provider's reporting lag; only unsettled rows are
-- ever refetched.
CREATE TABLE IF NOT EXISTS daily_precip (
    zip              CHAR(5) NOT NULL,
    observation_date DATE NOT NULL,
    station_id       VARCHAR(50) NOT NULL,
    precip_inches    NUMERIC(6, 3),
    precip_mm        NUMERIC(7, 2),
    quality_flag     VARCHAR(10),
    source           VARCHAR(16) NOT NULL,
    settled          BOOLEAN NOT NULL DEFAULT false,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, observation_date, station_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_zip_date
    ON daily_precip (zip, observation_date);

-- Hourly observations. Gridded rather than station-based, so keyed by ZIP +
-- UTC hour. Stored in UTC; the API converts to site-local on the way out.
CREATE TABLE IF NOT EXISTS hourly_precip (
    zip             CHAR(5) NOT NULL,
    observed_at_utc TIMESTAMPTZ NOT NULL,
    precip_inches   NUMERIC(6, 3),
    source          VARCHAR(16) NOT NULL,
    settled         BOOLEAN NOT NULL DEFAULT false,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zip, observed_at_utc, source)
);

CREATE INDEX IF NOT EXISTS idx_hourly_zip_time
    ON hourly_precip (zip, observed_at_utc);

-- One row per upstream provider call, attributed to the consumer that caused it.
-- Drives /usage and the 85%-of-quota warning.
CREATE TABLE IF NOT EXISTS upstream_call_log (
    id        BIGSERIAL PRIMARY KEY,
    client    VARCHAR(32) NOT NULL,
    provider  VARCHAR(16) NOT NULL,
    called_on DATE NOT NULL DEFAULT CURRENT_DATE,
    status    INT,
    called_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_provider_day
    ON upstream_call_log (provider, called_on);
