/**
 * card/openclaw-zeroclaw-per-conversation-wake-keying — Item 1 openclaw keying.
 *
 * Spec for `deriveWakeSessionKey(agentId, event)` (the new
 * `service/wake-session.ts`). Mirrors the merged hermes `derive_wake_session`
 * scheme (frozen in ADR-0019) and the hermes test shapes — distinctness,
 * same-entity continuity, domain-prefix keying (BR-2, the `offer.accepted` →
 * listing proof), bounded ephemeral fallback + distinctness (BR-3), the
 * `wake-<uuid4>` fallback, traversal refusal (BR-4), and the
 * `agent:<agentId>:klodi:<entity_id>` key shape (BR-5).
 *
 * These assertions ARE the spec — never weaken one to match a partial
 * implementation.
 */
import { describe, it, expect } from "vitest";
import {
  deriveWakeSessionKey,
  WAKE_SESSION_NAMESPACE,
} from "../../service/wake-session.js";
import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";

const AGENT = "main";

function offer(listing_id: string, event_id = "evt-offer"): NotificationEvent {
  return {
    kind: "offer.proposed",
    event_id,
    offer_id: "off-1",
    listing_id,
    buyer_handle: "buyer",
    amount: 1000,
    terms: null,
  };
}

function channelMessage(channel_id: string): ChannelMessageEvent {
  return {
    kind: "channel.message",
    event_id: "evt-chan",
    channel_id,
    message_id: "msg-1",
    sequence: 1,
    sender_user_id: "usr-1",
    sender_handle: "sender",
    content: "hello",
    created_at: "2026-06-30T00:00:00Z",
  };
}

describe("deriveWakeSessionKey (ADR-0019 per-conversation keying)", () => {
  // BR-1 — distinct entities → distinct keys; neither is the shared default.
  it("derives distinct keys for distinct listings (BR-1)", () => {
    const k1 = deriveWakeSessionKey(AGENT, offer("lst-1"));
    const k2 = deriveWakeSessionKey(AGENT, offer("lst-2"));
    expect(k1).not.toBe(k2);
    expect(k1).toBe("agent:main:klodi:lst-1");
    expect(k2).toBe("agent:main:klodi:lst-2");
    // Must NOT collapse onto the single shared default the bug is fixing.
    expect(k1).not.toBe("agent:main:main");
    expect(k2).not.toBe("agent:main:main");
  });

  // BR-1 — same entity → same key (conversation continuity).
  it("derives the same key for the same listing (BR-1)", () => {
    const k1 = deriveWakeSessionKey(AGENT, offer("lst-1", "evt-a"));
    const k2 = deriveWakeSessionKey(AGENT, offer("lst-1", "evt-b"));
    expect(k1).toBe(k2);
    expect(k1).toBe("agent:main:klodi:lst-1");
  });

  // BR-2 — offer.accepted carries BOTH listing_id and transaction_id; keying
  // MUST use the domain prefix (offer → listing), never first-id-present.
  it("keys offer.accepted off the LISTING prefix, not the transaction (BR-2)", () => {
    const event: NotificationEvent = {
      kind: "offer.accepted",
      event_id: "evt-acc",
      offer_id: "off-2",
      listing_id: "lst-8",
      seller_handle: "seller",
      amount: 1000,
      transaction_id: "txn-1",
    };
    const key = deriveWakeSessionKey(AGENT, event);
    expect(key).toBe("agent:main:klodi:lst-8");
    expect(key).not.toContain("txn-1");
  });

  it("keys channel events off channel_id", () => {
    expect(deriveWakeSessionKey(AGENT, channelMessage("chn-9"))).toBe(
      "agent:main:klodi:chn-9",
    );
  });

  it("keys transaction events off transaction_id, not the co-carried listing_id", () => {
    const event: NotificationEvent = {
      kind: "transaction.completed",
      event_id: "evt-txn",
      transaction_id: "txn-5",
      listing_id: "lst-13",
    };
    const key = deriveWakeSessionKey(AGENT, event);
    expect(key).toBe("agent:main:klodi:txn-5");
    expect(key).not.toContain("lst-13");
  });

  it("keys search.match off search_slug", () => {
    const event: NotificationEvent = {
      kind: "search.match",
      event_id: "evt-search",
      search_slug: "vintage-camera",
      listing_id: "lst-15",
      listing_summary: {
        title: "Pentax",
        asking_price: 9500,
        currency: "USD",
        fulfillment: [],
        seller_handle: "seller",
        photos: [],
      },
    };
    expect(deriveWakeSessionKey(AGENT, event)).toBe(
      "agent:main:klodi:vintage-camera",
    );
  });

  it("keys comment.created off listing_id", () => {
    const event: NotificationEvent = {
      kind: "comment.created",
      event_id: "evt-cmt",
      listing_id: "lst-14",
      comment_id: "cmt-1",
      handle: "commenter",
      body: "nice listing",
      mentions: [],
      created_at: "2026-06-30T00:00:00Z",
    };
    expect(deriveWakeSessionKey(AGENT, event)).toBe("agent:main:klodi:lst-14");
  });

  // BR-3 — an EMPTY mapped key field falls back to a bounded wake-<event_id>
  // ephemeral key (NOT an empty-entity `agent:main:klodi:` key); two such wakes
  // with distinct event_ids resolve to DIFFERENT keys (never a shared constant).
  it("falls back to a bounded wake-<event_id> key, distinct per event_id (BR-3)", () => {
    const k1 = deriveWakeSessionKey(AGENT, offer("", "evt-a"));
    const k2 = deriveWakeSessionKey(AGENT, offer("", "evt-b"));
    expect(k1).toBe("agent:main:klodi:wake-evt-a");
    expect(k2).toBe("agent:main:klodi:wake-evt-b");
    expect(k1).not.toBe(k2);
    // No empty-entity key (the "no empty session key" half of BR-4).
    expect(k1).not.toBe("agent:main:klodi:");
  });

  // BR-3 — neither a usable key field NOR an event_id → unique wake-<uuid4>,
  // so the fallback can never itself become a shared session.
  it("falls back to a unique wake-<uuid4> key when event_id is also absent (BR-3)", () => {
    const k1 = deriveWakeSessionKey(AGENT, offer("", ""));
    const k2 = deriveWakeSessionKey(AGENT, offer("", ""));
    expect(k1).toMatch(/^agent:main:klodi:wake-.+/);
    expect(k2).toMatch(/^agent:main:klodi:wake-.+/);
    expect(k1).not.toBe(k2);
  });

  // BR-4 — a non-empty poisoned id (path separator / parent ref / leading dot)
  // is REFUSED: derivation throws, mirroring hermes `_reject_traversal_entity_id`
  // (THREAT_MODEL T5). A poisoned id must never become a `--session` arg or a
  // derived filename — so it must never yield `klodi:../…`.
  it("refuses a traversal entity id by throwing (BR-4)", () => {
    for (const poisoned of ["../etc/passwd", "a/b", "..\\windows", ".hidden"]) {
      expect(
        () => deriveWakeSessionKey(AGENT, offer(poisoned)),
        `poisoned id ${JSON.stringify(poisoned)} must be refused`,
      ).toThrow();
    }
  });

  // BR-5 — every derived key carries the runtime prefix + the klodi: namespace.
  it("produces an agent:<agentId>:klodi:<entity_id> shaped key (BR-5)", () => {
    const key = deriveWakeSessionKey("custom-agent", offer("lst-1"));
    expect(key.startsWith(`agent:custom-agent:${WAKE_SESSION_NAMESPACE}`)).toBe(
      true,
    );
    expect(key).toBe("agent:custom-agent:klodi:lst-1");
  });
});
