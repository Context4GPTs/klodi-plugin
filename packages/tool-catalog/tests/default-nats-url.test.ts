/**
 * RED [unit] — the catalog default NATS URL is the pinned tls:// L4 proxy.
 *
 * `KLODI_DEFAULT_NATS_URL` is the single codegen source of truth
 * (tool-catalog/src/index.ts:719) that fans out to the py/rs mirrors. The
 * cutover flips it from the legacy `wss://klodi-net.4gpts.com` WS edge to the
 * raw-TLS L4 proxy `tls://hayabusa.proxy.rlwy.net:32770` (devops §1). It is
 * NOT `kodama.proxy.rlwy.net:37360` — that Railway host is pgvector's
 * Postgres proxy; pointing the NATS fallback at it would aim the client at
 * Postgres.
 *
 * QA-owned. NEVER weaken.
 */

import { describe, expect, it } from "vitest";

import { KLODI_DEFAULT_NATS_URL } from "../src/index.js";

const PINNED = "tls://hayabusa.proxy.rlwy.net:32770";

describe("KLODI_DEFAULT_NATS_URL", () => {
  it("is the pinned tls:// L4 proxy endpoint", () => {
    expect(KLODI_DEFAULT_NATS_URL).toBe(PINNED);
  });

  it("is not the retired wss:// edge default", () => {
    expect(KLODI_DEFAULT_NATS_URL).not.toContain("wss://");
    expect(KLODI_DEFAULT_NATS_URL).not.toContain("klodi-net.4gpts.com");
  });

  it("is not pgvector's kodama Postgres proxy", () => {
    expect(KLODI_DEFAULT_NATS_URL).not.toContain("kodama");
  });
});
