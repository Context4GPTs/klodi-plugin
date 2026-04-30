/**
 * Unit tests for UUID v4 subject-interpolation guard (P1-11).
 *
 * `publishChannelMessage` interpolates `channel_id` and `sender_user_id`
 * into a NATS subject. Unvalidated input containing wildcards (`*`,
 * `>`), `\r\n`, or whitespace could foul up the marketplace's
 * side-consumer subject parsing. The guard rejects anything that
 * isn't a strict UUID v4 before the subject is constructed.
 */

import type { JetStreamClient } from "@nats-io/jetstream";
import { describe, it, expect, vi } from "vitest";

import { publishChannelMessage } from "../src/publish.js";

function jsStub(): JetStreamClient {
  // The guard rejects before we ever hit the wire. The stub records
  // calls so we can assert publish() was never invoked on rejection.
  return {
    publish: vi.fn().mockResolvedValue({ seq: 1 }),
  } as unknown as JetStreamClient;
}

const VALID_CHANNEL = "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f";
const VALID_SENDER = "9c8d7e6f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

describe("publishChannelMessage UUID v4 guard", () => {
  it("publishes when both ids are valid UUID v4", async () => {
    const js = jsStub();
    const ack = await publishChannelMessage({
      js,
      channelId: VALID_CHANNEL,
      senderUserId: VALID_SENDER,
      senderHandle: "alice",
      content: "hello",
    });
    expect(ack.sequence).toBe(1);
    expect((js.publish as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it.each([
    ["empty string", ""],
    ["wildcard token", "*"],
    ["> wildcard", ">"],
    ["uuid with wildcard", "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1*"],
    ["uuid with newline", "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f\n"],
    ["uuid with leading whitespace", " 3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f"],
    ["uuid v1 (wrong version)", "3b9b1d2e-4a8c-1f1d-93f0-7c5b3a2e8c1f"],
    ["uuid bad variant", "3b9b1d2e-4a8c-4f1d-c3f0-7c5b3a2e8c1f"],
    ["dot injection", "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f.foo"],
  ])("rejects malformed channelId: %s", async (_label, bad) => {
    const js = jsStub();
    await expect(
      publishChannelMessage({
        js,
        channelId: bad,
        senderUserId: VALID_SENDER,
        senderHandle: "alice",
        content: "hello",
      }),
    ).rejects.toThrow(/channelId must be a UUID v4/);
    expect((js.publish as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("rejects malformed senderUserId before any wire write", async () => {
    const js = jsStub();
    await expect(
      publishChannelMessage({
        js,
        channelId: VALID_CHANNEL,
        senderUserId: "not-a-uuid",
        senderHandle: "alice",
        content: "hello",
      }),
    ).rejects.toThrow(/senderUserId must be a UUID v4/);
    expect((js.publish as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});
