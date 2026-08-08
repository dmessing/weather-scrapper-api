import { authenticate } from "./auth.js";

/** Seconds. Settled observations never change, so they cache effectively forever. */
export const CACHE_SETTLED = 31_536_000;
/** A range touching unsettled days, or anything forecast-shaped. */
export const CACHE_VOLATILE = 3_600;

export function json(
  body: unknown,
  init: { status?: number; maxAge?: number; swr?: number } = {},
): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (init.maxAge !== undefined) {
    const swr = init.swr ?? Math.min(init.maxAge, CACHE_VOLATILE);
    headers.set(
      "cache-control",
      `public, s-maxage=${init.maxAge}, stale-while-revalidate=${swr}`,
    );
  } else {
    headers.set("cache-control", "no-store");
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status ?? 200,
    headers,
  });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Wraps a handler with method checking, bearer auth, and error translation.
 * The authenticated client name is handed to the handler because it is the
 * attribution key for every upstream call the request goes on to make.
 */
export function route(
  handler: (request: Request, client: string) => Promise<Response> | Response,
  options: { method?: string; auth?: boolean } = {},
) {
  const method = options.method ?? "GET";
  const requireAuth = options.auth ?? true;

  return async function (request: Request): Promise<Response> {
    if (request.method !== method) {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    let client = "anonymous";
    if (requireAuth) {
      const authenticated = authenticate(request);
      if (!authenticated) {
        return json({ error: "unauthorized" }, { status: 401 });
      }
      client = authenticated;
    }

    try {
      return await handler(request, client);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          { error: error.message, detail: error.detail },
          { status: error.status },
        );
      }
      console.error("unhandled error", error);
      return json({ error: "internal_error" }, { status: 500 });
    }
  };
}
