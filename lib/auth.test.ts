import { describe, expect, it } from "vitest";
import { authenticate, __test } from "./auth.js";

const { parseClientTokens } = __test;

const registry = parseClientTokens("fog-light:aaa111,rainhedge:bbb222");

function requestWith(header?: string): Request {
  return new Request("https://example.test/api/v1/health", {
    headers: header ? { authorization: header } : {},
  });
}

describe("parseClientTokens", () => {
  it("maps token -> client name", () => {
    expect([...registry.entries()]).toEqual([
      ["aaa111", "fog-light"],
      ["bbb222", "rainhedge"],
    ]);
  });

  it("is empty when unset, rather than throwing", () => {
    expect(parseClientTokens(undefined).size).toBe(0);
    expect(parseClientTokens("").size).toBe(0);
  });

  it("tolerates whitespace and skips malformed pairs", () => {
    const parsed = parseClientTokens(" a:1 , garbage , :2 , b: , c:3 ");
    expect([...parsed.entries()]).toEqual([
      ["1", "a"],
      ["3", "c"],
    ]);
  });

  it("keeps colons inside a token", () => {
    expect([...parseClientTokens("a:tok:with:colons").entries()]).toEqual([
      ["tok:with:colons", "a"],
    ]);
  });
});

describe("authenticate", () => {
  it("returns the client name for a known token", () => {
    expect(authenticate(requestWith("Bearer aaa111"), registry)).toBe("fog-light");
    expect(authenticate(requestWith("Bearer bbb222"), registry)).toBe("rainhedge");
  });

  it("accepts the scheme case-insensitively", () => {
    expect(authenticate(requestWith("bearer aaa111"), registry)).toBe("fog-light");
  });

  it("rejects an unknown token", () => {
    expect(authenticate(requestWith("Bearer nope99"), registry)).toBeNull();
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths; the guard must catch it.
    expect(authenticate(requestWith("Bearer short"), registry)).toBeNull();
    expect(authenticate(requestWith("Bearer " + "x".repeat(500)), registry)).toBeNull();
  });

  it("rejects a missing or malformed header", () => {
    expect(authenticate(requestWith(), registry)).toBeNull();
    expect(authenticate(requestWith("aaa111"), registry)).toBeNull();
    expect(authenticate(requestWith("Basic aaa111"), registry)).toBeNull();
    expect(authenticate(requestWith("Bearer "), registry)).toBeNull();
  });

  it("rejects everything when no clients are configured", () => {
    expect(authenticate(requestWith("Bearer aaa111"), new Map())).toBeNull();
  });
});
