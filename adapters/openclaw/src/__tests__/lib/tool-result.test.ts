/**
 * Tests for adapters/openclaw/src/lib/tool-result.ts
 *
 * The legacy `errorResult / formatError / requireCreds` helpers were
 * removed in the ADR-0011 envelope rollout. Their replacements
 * (`envelopeToolResult`, `requireCredsEnvelope`) emit the canonical
 * four-key envelope; `requestAndHandle` now routes errors through
 * the envelope helper so every adapter tool sees the same shape.
 *
 * See `envelope.test.ts` for the envelope-shape contract; this file
 * covers the `tool-result.ts` orchestration layer (jsonResult,
 * requireCredsEnvelope, requestAndHandle, rawRequest).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
  requestAndHandle,
  requireCredsEnvelope,
} from "../../lib/tool-result.js";
import { KlodiRequestError } from "../helpers/mock-nats.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
} from "../helpers/mock-nats.js";

const ENVELOPE_KEYS = ["details", "error", "message", "recovery_hint"];

function parseEnvelope(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("jsonResult", () => {
  it("wraps data in text content with JSON formatting", () => {
    const data = { id: "abc", price: 1500, active: true };
    const result = jsonResult(data);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe(JSON.stringify(data, null, 2));
    expect(result.isError).toBeUndefined();
  });

  it("handles arrays", () => {
    expect(jsonResult([1, 2, 3]).content[0]!.text).toBe(
      JSON.stringify([1, 2, 3], null, 2),
    );
  });

  it("handles null and primitives", () => {
    expect(jsonResult(null).content[0]!.text).toBe("null");
    expect(jsonResult("hello").content[0]!.text).toBe('"hello"');
    expect(jsonResult(42).content[0]!.text).toBe("42");
  });
});

describe("envelopeToolResult", () => {
  it("converts a KlodiRequestError into the canonical envelope tool-result", () => {
    const err = new KlodiRequestError({
      error: "listing_not_owned_by_caller",
      message: "Listing belongs to another user",
      details: { listing_id: "abc" },
    });
    const result = envelopeToolResult(err);

    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0]!.text!);
    expect(Object.keys(env).sort()).toEqual(ENVELOPE_KEYS);
    expect(env["error"]).toBe("listing_not_owned_by_caller");
    expect(env["recovery_hint"]).toBeNull();
  });

  it("converts a generic Error into internal_error envelope", () => {
    const result = envelopeToolResult(new Error("socket closed"));

    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0]!.text!);
    expect(env["error"]).toBe("internal_error");
    expect(env["recovery_hint"]).toBeNull();
  });

  it("converts non-Error throws into internal_error envelope", () => {
    expect(parseEnvelope(envelopeToolResult("boom").content[0]!.text!)["error"]).toBe(
      "internal_error",
    );
    expect(parseEnvelope(envelopeToolResult(42).content[0]!.text!)["error"]).toBe(
      "internal_error",
    );
  });
});

describe("requireCredsEnvelope", () => {
  it("returns a not_registered envelope tool-result when credentials are absent", () => {
    // hasCredentials() reads from disk; with no temp-home wired, the
    // config path resolves to a default that won't exist in CI.
    const result = requireCredsEnvelope();
    expect(result).not.toBeNull();
    const env = parseEnvelope(result!.content[0]!.text!);
    expect(env["error"]).toBe("not_registered");
    const hint = env["recovery_hint"] as Record<string, unknown>;
    expect(hint["kind"]).toBe("cli");
    expect(hint["command"]).toBe("klodi-openclaw-register");
  });
});

describe("requestAndHandle", () => {
  beforeEach(() => clearNatsResponses());

  it("returns jsonResult on success", async () => {
    mockNatsResponse("klodi_test_subject", { ok: true, id: "x" });
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      ok: true,
      id: "x",
    });
  });

  it("returns the canonical envelope when KlodiRequestError is thrown", async () => {
    mockNatsError(
      "klodi_test_subject",
      new KlodiRequestError({
        error: "listing_not_owned_by_caller",
        message: "Listing belongs to another user",
        details: { listing_id: "abc" },
      }),
    );
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0]!.text!);
    expect(env["error"]).toBe("listing_not_owned_by_caller");
    expect(env["recovery_hint"]).toBeNull();
  });

  it("returns the internal_error envelope for generic transport errors", async () => {
    mockNatsError("klodi_test_subject", new Error("connection lost"));
    const result = await requestAndHandle("klodi_test_subject", {});
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0]!.text!);
    expect(env["error"]).toBe("internal_error");
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
    const err = new KlodiRequestError({
      error: "internal_error",
      message: "Boom",
    });
    mockNatsError("klodi_raw", err);
    await expect(rawRequest("klodi_raw", {})).rejects.toBe(err);
  });
});
