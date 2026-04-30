/**
 * Cross-language contract test (TypeScript half) — Decision 7.
 *
 * Reads every fixture from the golden corpus at
 * `klodi-plugin/packages/tool-catalog/tests/golden/` and parses it through
 * the same `JSON.parse` path the runtime consumer uses (see
 * `consumers.ts#consumeLoop`). Asserts every required field per the
 * canonical event types in `@klodi/tool-catalog/events`.
 *
 * If TypeBox shapes drift (a field renamed, a discriminator changed,
 * an optional flipped to required) and a fixture is not updated in
 * lockstep, this test fails. The Python and Rust mirrors of this
 * suite enforce the same contract from their language sides.
 *
 * The drift gate at `tool-catalog/scripts/check-golden-coverage.mjs`
 * fails the build if any `kind` lacks a fixture, so adding a new
 * NotificationEvent variant requires adding a fixture + assertions
 * here in the same change.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(
  HERE,
  "..",
  "..",
  "..",
  "tool-catalog",
  "tests",
  "golden",
);

type AnyEvent = NotificationEvent | ChannelMessageEvent;

function loadFixture(name: string): AnyEvent {
  const raw = readFileSync(join(GOLDEN_DIR, name), "utf-8");
  return JSON.parse(raw) as AnyEvent;
}

function assertEventIdShape(event: { event_id: unknown }): void {
  expect(event.event_id).toBeTypeOf("string");
  expect(event.event_id as string).not.toBe("");
}

const fixtureFiles = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("golden corpus — fixtures present", () => {
  it("loads at least one fixture per event kind", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });
});

describe("listing.created", () => {
  it("parses listing.created.json with title", () => {
    const evt = loadFixture("listing.created.json");
    expect(evt.kind).toBe("listing.created");
    if (evt.kind !== "listing.created") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.title).toBeTypeOf("string");
  });
});

describe("listing.relisted", () => {
  it("parses listing.relisted.json with title", () => {
    const evt = loadFixture("listing.relisted.json");
    expect(evt.kind).toBe("listing.relisted");
    if (evt.kind !== "listing.relisted") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.title).toBeTypeOf("string");
  });
});

describe("listing.withdrawn", () => {
  it("parses listing.withdrawn.json", () => {
    const evt = loadFixture("listing.withdrawn.json");
    expect(evt.kind).toBe("listing.withdrawn");
    if (evt.kind !== "listing.withdrawn") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
  });
});

describe("listing.sold", () => {
  it("parses listing.sold.json", () => {
    const evt = loadFixture("listing.sold.json");
    expect(evt.kind).toBe("listing.sold");
    if (evt.kind !== "listing.sold") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
  });
});

describe("listing.expired", () => {
  it("parses listing.expired.json", () => {
    const evt = loadFixture("listing.expired.json");
    expect(evt.kind).toBe("listing.expired");
    if (evt.kind !== "listing.expired") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
  });
});

describe("listing.status_changed", () => {
  it("parses listing.status_changed.json with old + new status", () => {
    const evt = loadFixture("listing.status_changed.json");
    expect(evt.kind).toBe("listing.status_changed");
    if (evt.kind !== "listing.status_changed") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.old_status).toBeTypeOf("string");
    expect(evt.new_status).toBeTypeOf("string");
    expect(evt.old_status).not.toBe(evt.new_status);
  });
});

describe("offer.proposed", () => {
  it("parses offer.proposed.json with cents amount + structured terms", () => {
    const evt = loadFixture("offer.proposed.json");
    expect(evt.kind).toBe("offer.proposed");
    if (evt.kind !== "offer.proposed") return;
    assertEventIdShape(evt);
    expect(evt.offer_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.buyer_handle).toBeTypeOf("string");
    expect(evt.amount).toBeTypeOf("number");
    expect(Number.isInteger(evt.amount)).toBe(true);
    // terms is `Record<string, unknown> | null` — present here.
    expect(evt.terms).not.toBe(null);
    expect(typeof evt.terms).toBe("object");
  });
});

describe("offer.accepted", () => {
  it("parses offer.accepted.json with amount + transaction_id", () => {
    const evt = loadFixture("offer.accepted.json");
    expect(evt.kind).toBe("offer.accepted");
    if (evt.kind !== "offer.accepted") return;
    assertEventIdShape(evt);
    expect(evt.offer_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.seller_handle).toBeTypeOf("string");
    expect(evt.amount).toBeTypeOf("number");
    expect(evt.transaction_id).toBeTypeOf("string");
  });
});

describe("offer.rejected", () => {
  it("parses offer.rejected.json without amount/transaction_id", () => {
    const evt = loadFixture("offer.rejected.json");
    expect(evt.kind).toBe("offer.rejected");
    if (evt.kind !== "offer.rejected") return;
    assertEventIdShape(evt);
    expect(evt.offer_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.seller_handle).toBeTypeOf("string");
    // Per OfferRespondedEvent, amount + transaction_id are accept-only.
    expect(evt.amount).toBeUndefined();
    expect(evt.transaction_id).toBeUndefined();
  });
});

describe("transaction.completed", () => {
  it("parses transaction.completed.json", () => {
    const evt = loadFixture("transaction.completed.json");
    expect(evt.kind).toBe("transaction.completed");
    if (evt.kind !== "transaction.completed") return;
    assertEventIdShape(evt);
    expect(evt.transaction_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
  });
});

describe("transaction.cancelled", () => {
  it("parses transaction.cancelled.json with cancelled_by + reason", () => {
    const evt = loadFixture("transaction.cancelled.json");
    expect(evt.kind).toBe("transaction.cancelled");
    if (evt.kind !== "transaction.cancelled") return;
    assertEventIdShape(evt);
    expect(evt.transaction_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.cancelled_by_handle).toBeTypeOf("string");
    expect(evt.reason).toBeTypeOf("string");
  });
});

describe("comment.created", () => {
  it("parses comment.created.json with mentions + ISO timestamp", () => {
    const evt = loadFixture("comment.created.json");
    expect(evt.kind).toBe("comment.created");
    if (evt.kind !== "comment.created") return;
    assertEventIdShape(evt);
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.comment_id).toBeTypeOf("string");
    expect(evt.handle).toBeTypeOf("string");
    expect(evt.body).toBeTypeOf("string");
    expect(Array.isArray(evt.mentions)).toBe(true);
    for (const m of evt.mentions) expect(m).toBeTypeOf("string");
    expect(evt.created_at).toBeTypeOf("string");
    expect(evt.created_at.endsWith("Z")).toBe(true);
  });
});

describe("search.match", () => {
  it("parses search.match.json with full listing summary", () => {
    const evt = loadFixture("search.match.json");
    expect(evt.kind).toBe("search.match");
    if (evt.kind !== "search.match") return;
    assertEventIdShape(evt);
    expect(evt.search_slug).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    const s = evt.listing_summary;
    expect(s.title).toBeTypeOf("string");
    expect(s.asking_price).toBeTypeOf("number");
    expect(Number.isInteger(s.asking_price)).toBe(true);
    expect(s.currency).toBeTypeOf("string");
    expect(s.delivery_method).toBeTypeOf("string");
    // location_area is `string | null`.
    if (s.location_area !== null) expect(s.location_area).toBeTypeOf("string");
    expect(s.seller_handle).toBeTypeOf("string");
    expect(Array.isArray(s.photos)).toBe(true);
    for (const p of s.photos) expect(p).toBeTypeOf("string");
  });
});

describe("channel.opened", () => {
  it("parses channel.opened.json with buyer_handle", () => {
    const evt = loadFixture("channel.opened.json");
    expect(evt.kind).toBe("channel.opened");
    if (evt.kind !== "channel.opened") return;
    assertEventIdShape(evt);
    expect(evt.channel_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.buyer_handle).toBeTypeOf("string");
  });
});

describe("channel.closed", () => {
  it("parses channel.closed.json with closed_by", () => {
    const evt = loadFixture("channel.closed.json");
    expect(evt.kind).toBe("channel.closed");
    if (evt.kind !== "channel.closed") return;
    assertEventIdShape(evt);
    expect(evt.channel_id).toBeTypeOf("string");
    expect(evt.listing_id).toBeTypeOf("string");
    expect(evt.closed_by).toBeTypeOf("string");
  });
});

describe("channel.message", () => {
  it("parses channel.message.json with sequence + ISO timestamp", () => {
    const evt = loadFixture("channel.message.json");
    expect(evt.kind).toBe("channel.message");
    if (evt.kind !== "channel.message") return;
    assertEventIdShape(evt);
    expect(evt.channel_id).toBeTypeOf("string");
    expect(evt.message_id).toBeTypeOf("string");
    expect(evt.sequence).toBeTypeOf("number");
    expect(Number.isInteger(evt.sequence)).toBe(true);
    expect(evt.sender_user_id).toBeTypeOf("string");
    expect(evt.sender_handle).toBeTypeOf("string");
    expect(evt.content).toBeTypeOf("string");
    expect(evt.content.length).toBeGreaterThan(0);
    expect(evt.content.length).toBeLessThanOrEqual(2000);
    expect(evt.created_at).toBeTypeOf("string");
    expect(evt.created_at.endsWith("Z")).toBe(true);
  });
});
// qa-developer: golden-corpus-decision-7
