import { describe, expect, it } from "vitest";
import handler from "../api/v1/health.js";

// No CLIENT_TOKENS in the test env, so no bearer token can authenticate here.
// That is exactly the state the shallow check must survive and the deep check
// must refuse.

const url = "https://example.test/api/v1/health";

describe("GET /api/v1/health", () => {
  it("answers the shallow check without a token", async () => {
    const response = await handler(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("noaa-precip");
    expect(body.auth_configured).toBe(false);
  });

  it("refuses the deep check without a token", async () => {
    const response = await handler(new Request(`${url}?deep=1`));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects non-GET methods", async () => {
    const response = await handler(new Request(url, { method: "POST" }));
    expect(response.status).toBe(405);
  });
});
