/**
 * Typed client for the noaa-precip service.
 *
 * SOURCE OF TRUTH: clients/ts/precip-client.ts in the noaa-precip repo.
 * Vendored into consumers by copying — if you are editing a copy, edit the
 * original too or the two will drift.
 *
 * Server-side only. The bearer token authenticates a *service*, not a user; a
 * token that reaches a browser is a public token, and a public token here lets
 * a stranger exhaust the shared NOAA quota.
 */
import { z } from "zod";

const dailyRecordSchema = z.object({
  date: z.string(),
  station: z.string(),
  precip_inches: z.number(),
  precip_mm: z.number(),
  quality_flag: z.string().nullable(),
  settled: z.boolean(),
});

const dailyAggregateSchema = z.object({
  date: z.string(),
  precip_inches: z.number(),
  station_count: z.number(),
});

const coverageSchema = z.object({
  expected_days: z.number().optional(),
  present_days: z.number().optional(),
  expected_hours: z.number().optional(),
  present_hours: z.number().optional(),
  pct: z.number(),
});

const metaSchema = z.object({
  source: z.string(),
  cache: z.string(),
  upstream_calls: z.number(),
});

const locationSchema = z.object({
  zip: z.string().nullable().optional(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  timezone: z.string().optional(),
  key: z.string().optional(),
  stations: z.array(z.object({ id: z.string(), distance_mi: z.number() })).optional(),
});

export const dailyResponseSchema = z.object({
  location: locationSchema,
  grain: z.literal("daily"),
  unit: z.string(),
  range: z.object({ start: z.string(), end: z.string() }),
  records: z.array(dailyRecordSchema),
  aggregate: z.array(dailyAggregateSchema),
  coverage: coverageSchema,
  meta: metaSchema,
});

export const hourlyResponseSchema = z.object({
  location: locationSchema,
  grain: z.literal("hourly"),
  unit: z.string(),
  range: z.object({ start: z.string(), end: z.string() }),
  archive_max_end_date: z.string(),
  records: z.array(
    z.object({
      timestamp_local: z.string(),
      timestamp_utc: z.string(),
      precip_inches: z.number(),
    }),
  ),
  coverage: coverageSchema,
  meta: metaSchema,
});

export const forecastResponseSchema = z.object({
  location: locationSchema,
  grain: z.literal("forecast"),
  unit: z.string(),
  issued_at: z.string(),
  daily: z.array(
    z.object({
      date: z.string(),
      precip_inches: z.number(),
      max_probability_percent: z.number().nullable(),
    }),
  ),
  intervals: z.object({
    precipitation: z.array(
      z.object({
        valid_from: z.string(),
        valid_to: z.string(),
        hours: z.number(),
        value: z.number(),
      }),
    ),
    probability: z.array(
      z.object({
        valid_from: z.string(),
        valid_to: z.string(),
        hours: z.number(),
        value: z.number(),
      }),
    ),
  }),
  meta: metaSchema,
});

export type DailyResponse = z.infer<typeof dailyResponseSchema>;
export type HourlyResponse = z.infer<typeof hourlyResponseSchema>;
export type ForecastResponse = z.infer<typeof forecastResponseSchema>;

/** A structured failure, so callers can distinguish "no coverage" from "service down". */
export class PrecipApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "PrecipApiError";
  }
}

export interface PrecipClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class PrecipClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PrecipClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.PRECIP_API_URL;
    const token = options.token ?? process.env.PRECIP_API_TOKEN;

    if (!baseUrl) throw new Error("PRECIP_API_URL is not set");
    if (!token) throw new Error("PRECIP_API_TOKEN is not set");

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const response = await this.fetchImpl(`${this.baseUrl}${path}?${query}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });

    const body: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = body as { error?: string; detail?: unknown };
      throw new PrecipApiError(response.status, error.error ?? "unknown_error", error.detail);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new PrecipApiError(response.status, "unexpected_response_shape", parsed.error.issues);
    }
    return parsed.data;
  }

  /** Daily precipitation for a ZIP. Max 366 days per call. */
  daily(zip: string, start: string, end: string): Promise<DailyResponse> {
    return this.get("/api/v1/precip/daily", { zip, start, end }, dailyResponseSchema);
  }

  /** Hourly precipitation, addressed by ZIP or by coordinates. */
  hourly(
    location: { zip: string } | { lat: number; lon: number },
    start: string,
    end: string,
  ): Promise<HourlyResponse> {
    const params =
      "zip" in location
        ? { zip: location.zip }
        : { lat: String(location.lat), lon: String(location.lon) };
    return this.get("/api/v1/precip/hourly", { ...params, start, end }, hourlyResponseSchema);
  }

  /** Forecast for up to 7 days from today at the site. */
  forecast(
    location: { zip: string } | { lat: number; lon: number },
    days = 7,
  ): Promise<ForecastResponse> {
    const params =
      "zip" in location
        ? { zip: location.zip }
        : { lat: String(location.lat), lon: String(location.lon) };
    return this.get(
      "/api/v1/precip/forecast",
      { ...params, days: String(days) },
      forecastResponseSchema,
    );
  }
}
