/**
 * Tests for adapters/openclaw/src/lib/tool-result.ts
 *
 * Pure helpers (jsonResult, errorResult, formatError) are unit-tested
 * directly. requestAndHandle / rawRequest go through getClient() and
 * have coverage in the per-tool test files via the mock-nats helper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import {
  jsonResult,
  errorResult,
  formatError,
  requireCreds,
  requestAndHandle,
  rawRequest,
} from "../../lib/tool-result.js";
import { KlodiRequestError } from "../helpers/mock-nats.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
} from "../helpers/mock-nats.js";

describe("jsonResult", () => {
  it("wraps data in text content with JSON formatting", () => {
    const data = { id: "abc", price: 1500, active: true };
    const result = jsonResult(data);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    expect(result.isError).toBeUndefined();
  });

  it("handles arrays", () => {
    expect(jsonResult([1, 2, 3]).content[0].text).toBe(
      JSON.stringify([1, 2, 3], null, 2),
    );
  });

  it("handles null and primitives", () => {
    expect(jsonResult(null).content[0].text).toBe("null");
    expect(jsonResult("hello").content[0].text).toBe('"hello"');
    expect(jsonResult(42).content[0].text).toBe("42");
  });
});

describe("errorResult", () => {
  it("sets isError: true and preserves the message verbatim", () => {
    const msg = "NOT_FOUND: Listing abc-123 does not exist";
    const result = errorResult(msg);

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(msg);
  });
});

describe("formatError", () => {
  it("renders KlodiRequestError as 'CODE: message'", () => {
    const err = new KlodiRequestError("Listing not found", "NOT_FOUND");
    expect(formatError(err)).toBe("NOT_FOUND: Listing not found");
  });

  it("renders generic Error as 'Request failed: <message>'", () => {
    expect(formatError(new Error("socket closed"))).toBe(
      "Request failed: socket closed",
    );
  });

  it("renders non-Error values via String()", () => {
    expect(formatError("boom")).toBe("Request failed: boom");
    expect(formatError(42)).toBe("Request failed: 42");
  });
});

describe("requireCreds", () => {
  it("returns an error string when credentials are absent", () => {
    // hasCredentials() reads from disk; with no temp-home wired, the
    // config path resolves to a default that won't exist in CI.
    const result = requireCreds();
    expect(result).toBe("Not registered. Use klodi_register first.");
  });
});

describe("requestAndHandle", () => {
  beforeEach(() => clearNatsResponses());

  it("returns jsonResult on success", async () => {
    mockNatsResponse("klodi_test_subject", { ok: true, id: "x" });
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text!)).toEqual({
      ok: true,
      id: "x",
    });
  });

  it("formats KlodiRequestError into errorResult", async () => {
    mockNatsError(
      "klodi_test_subject",
      new KlodiRequestError("Listing not found", "NOT_FOUND"),
    );
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("NOT_FOUND: Listing not found");
  });

  it("formats generic transport errors into errorResult", async () => {
    mockNatsError("klodi_test_subject", new Error("connection lost"));
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Request failed: connection lost");
  });
});

describe("rawRequest", () => {
  beforeEach(() => clearNatsResponses());

  it("returns the parsed response on success", async () => {
    mockNatsResponse("klodi_raw", { listing_id: "abc" });
    const out = await rawRequest<{ listing_id: string }>("klodi_raw", {});
    expect(out.listing_id).toBe("abc");
  });

  it("propagates errors", async () => {
    const err = new KlodiRequestError("Boom", "INTERNAL_ERROR");
    mockNatsError("klodi_raw", err);
    await expect(rawRequest("klodi_raw", {})).rejects.toBe(err);
  });
});
