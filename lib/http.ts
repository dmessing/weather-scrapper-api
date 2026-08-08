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

function normalizeRequest(req: any): Request {
  if (req instanceof Request) {
    return req;
  }
  const host = req.headers?.host || "localhost";
  const protocol = req.headers?.["x-forwarded-proto"] || "https";
  const rawUrl = req.url || "/";
  const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${protocol}://${host}${rawUrl}`;

  const headers = new Headers();
  if (req.headers) {
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (value !== undefined) {
        headers.set(key, String(value));
      }
    }
  }

  return new Request(fullUrl, {
    method: req.method || "GET",
    headers,
  });
}

async function respond(res: any, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((val: string, key: string) => {
    res.setHeader(key, val);
  });
  const bodyText = await response.text();
  res.end(bodyText);
}

/**
 * Wraps a handler with method checking, bearer auth, and error translation.
 * The authenticated client name is handed to the handler because it is the
 * attribution key for every upstream call the request goes on to make.
 * Supports both Web standard Request/Response and Node (req, res) Serverless Functions.
 */
export function route(
  handler: (request: Request, client: string) => Promise<Response> | Response,
  options: { method?: string; auth?: boolean } = {},
) {
  const method = options.method ?? "GET";
  const requireAuth = options.auth ?? true;

  return async function (req: any, res?: any): Promise<any> {
    const isNodeReqRes = res && typeof res.setHeader === "function";
    const request = normalizeRequest(req);
    let response: Response;

    if (request.method !== method) {
      response = json({ error: "method_not_allowed" }, { status: 405 });
    } else {
      let client = "anonymous";
      let authOk = true;

      if (requireAuth) {
        const authenticated = authenticate(request);
        if (!authenticated) {
          response = json({ error: "unauthorized" }, { status: 401 });
          authOk = false;
        } else {
          client = authenticated;
        }
      }

      if (!requireAuth || authOk) {
        try {
          response = await handler(request, client);
        } catch (error) {
          if (error instanceof ApiError) {
            response = json(
              { error: error.message, detail: error.detail },
              { status: error.status },
            );
          } else {
            console.error("unhandled error", error);
            response = json({ error: "internal_error" }, { status: 500 });
          }
        }
      }
    }

    if (isNodeReqRes) {
      await respond(res, response!);
      return;
    }

    return response!;
  };
}

export { normalizeRequest, respond };
