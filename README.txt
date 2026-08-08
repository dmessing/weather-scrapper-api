## TL;DR

* **Primary Method:** The **NOAA NCEI Climate Data Online (CDO) API v2** is the best direct method for historical rainfall data, natively supporting 5-digit US ZIP codes via the `ZIP:#####` location identifier.
* **Real-time / Forecast Method:** For real-time, recent 24-hour, or forecast precipitation, pair the **NOAA National Weather Service (NWS) API** (`api.weather.gov`) with a lightweight ZIP-to-Lat/Lon geocoder.
* **Recommended Architecture:** Build a Python/Node.js ETL service that queries NOAA CDO for historical daily totals (GHCND dataset), falls back to ACIS or NWS for real-time gap-filling, and caches responses to stay well under NOAA rate limits.

---

## NOAA Rainfall Data Retrieval Options

When sourcing precipitation (rainfall) data from NOAA using ZIP codes, three primary approaches exist depending on your time range and latency requirements:

| Parameter / Feature | **Option 1: NOAA CDO API v2** (Recommended for Historical) | **Option 2: ACIS API** (Recommended for Speed & Aggregations) | **Option 3: NOAA NWS API** (Recommended for Real-Time/Forecast) |
| --- | --- | --- | --- |
| **ZIP Code Support** | **Native** (`locationid=ZIP:06107`) | **Native** (`sids="06107"`) | **Indirect** (Requires ZIP → Lat/Lon geocode) |
| **Primary Dataset** | GHCND (Global Historical Climatology Network) | Regional Climate Centers Multi-station Blend | NWS Station Grid & Real-time Observations |
| **Metrics** | `PRCP` (Precipitation), `SNOW`, `TMAX`, `TMIN` | Daily Total, Monthly Aggregates, Normal Comparison | Hourly Quantitative Precipitation Estimate (QPF) |
| **Authentication** | Free API Token Required | None Required | None Required (Requires `User-Agent` header) |
| **Rate Limit** | 5 requests/sec, 10,000 requests/day | Fair-use policy | Generous rate limits (throttled on burst) |

---

## Recommended Strategy: Hybrid Ingestion Model

To get accurate rainfall data while avoiding NOAA rate limits and data lag:

* **Use NOAA CDO API v2 as the core source** for settled daily/monthly historical precipitation logs.
* **Use a static ZCTA (ZIP Code Tabulation Area) centroid database** (or US Census Geocoder) to map ZIP codes to `(latitude, longitude)` pairs.
* **Query the NOAA NWS API (`api.weather.gov`) or ACIS** using coordinates for real-time and recent 24-hour precip observations when CDO has a 24–48 hour reporting lag.

---

## Technical Specification: NOAA ZIP Code Rainfall Ingestion Tool

### 1. System Overview & Architecture

* **Service Name:** `noaa-zip-rainfall-extractor`
* **Purpose:** Automated CLI and REST service to retrieve, normalize, and store daily and hourly precipitation records for any list of US ZIP codes.
* **Tech Stack:** Python 3.11+ (or Node.js/TypeScript), SQLite/PostgreSQL, Redis (for response caching), `pydantic`, `httpx`/`requests`.

---

### 2. Pipeline Workflow

1. **Input Parsing & Location Resolution:** Pre-processing phase.
* Validate the 5-digit US ZIP code list.
* Check local ZCTA cache for latitude/longitude coordinates and corresponding NCEI Location ID (`ZIP:#####`).
* Resolve closest GHCND weather stations if specific station-level tracking is enabled.


2. **Rate-Limited API Dispatcher:** Execution phase.
* Dispatch HTTP GET requests to NOAA CDO API v2 with header `token: <NOAA_TOKEN>`.
* Implement token bucket algorithm enforced at **4 requests/second** (below the 5 req/sec ceiling).
* Cache raw JSON responses in Redis with a 24-hour TTL for historical requests.


3. **Payload Normalization & QC:** Data transformation.
* Parse `PRCP` values. Convert standard tenths of millimeters (GHCND default metric) into standard inches and millimeters.
* Filter out invalid records or station reporting errors (e.g., missing data flags `M`, `S`).
* Compute weighted average if multiple reporting weather stations sit inside the same ZIP code boundary.


4. **Storage & Export Rendering:** Output phase.
* Write structured data to local database (PostgreSQL / SQLite) or output directly as CSV, JSON, or Parquet.
* Return status metrics including total ZIP codes processed, coverage completeness, and API quota usage.


---

### 3. API Contracts & Endpoint Specifications

#### Primary NOAA CDO Endpoint

```http
GET /cdo-web/api/v2/data?datasetid=GHCND&locationid=ZIP:06107&datatypeid=PRCP&startdate=2026-08-01&enddate=2026-08-07&units=standard&limit=1000 HTTP/1.1
Host: www.ncdc.noaa.gov
token: YOUR_NOAA_API_TOKEN

```

#### Sample API Response Schema (NOAA CDO v2)

```json
{
  "metadata": {
    "resultset": {
      "offset": 1,
      "count": 7,
      "limit": 1000
    }
  },
  "results": [
    {
      "date": "2026-08-01T00:00:00",
      "datatype": "PRCP",
      "station": "GHCND:US1CTHR0001",
      "attributes": ",,N,",
      "value": 0.42
    }
  ]
}

```

---

### 4. Database Schema Specification

```sql
CREATE TABLE IF NOT EXISTS zip_rainfall_records (
    id SERIAL PRIMARY KEY,
    zip_code VARCHAR(5) NOT NULL,
    observation_date DATE NOT NULL,
    station_id VARCHAR(50) NOT NULL,
    precip_inches NUMERIC(5, 2),
    precip_mm NUMERIC(6, 2),
    data_quality_flag VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_zip_date_station UNIQUE (zip_code, observation_date, station_id)
);

CREATE INDEX idx_zip_date ON zip_rainfall_records (zip_code, observation_date);

```

---

### 5. Error Handling & Rate Limiting Rules

* **Exponential Backoff:** Retries on HTTP `429 Too Many Requests` or `503 Service Unavailable` with backoff multiplier $2^n \times 0.5$ seconds (max 3 retries).
* **Missing Station Coverage:** If `ZIP:#####` returns zero stations in NOAA CDO:
1. Retrieve ZIP centroid Lat/Lon coordinates from ZCTA reference table.
2. Query bounding box radius search (`/cdo-web/api/v2/stations?extent=...`) to identify the nearest active station within 15 miles.


* **Daily Quota Protection:** Monitor daily call count against the 10,000 requests/day limit and log warnings when reaching 85% capacity.

---
