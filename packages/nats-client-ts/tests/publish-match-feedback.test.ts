/**
 * Publish-boundary tests for `publishMatchFeedback` (TS half) — the
 * flywheel-emit helper (SC8).
 *
 * RED-first: `publishMatchFeedback` is not exported from `../src/publish.js`
 * yet, so the import fails to resolve until the expert-developer adds the
 * helper. (TS RED for a not-yet-existent export surfaces at import — the
 * idiomatic signal, mirroring how `publish-uuid.test.ts` imports the
 * channel-message helper.)
 *
 * We MOCK THE NATS BOUNDARY, NOT LOGIC: a `jsStub()` with a `vi.fn()` on
 * `js.publish`, exactly like the existing `publish-uuid.test.ts`. The
 * assertions are about the bytes that hit the wire — subject, exact body,
 * dedup header — which is the layer where cross-language byte parity is
 * defined. The hermes/nanobot adapters reach this same helper via the Python
 * port; this file is the TS arm of the 3-language parity set.
 *
 * The wire contract is pinned by the SIBLING marketplace at
 * `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts`:
 *   subject  p2p.v1.searches.match_feedback
 *   body     { search_slug, listing_id, outcome, action_on_match? }
 *   additionalProperties: false  — NO label, NO listing_summary.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts to match a
 * helper that sends extra fields or the wrong subject. The helper serves the
 * contract; if it diverges, the helper is wrong.
 */

import type { JetStreamClient } from "@nats-io/jetstream";
import { describe, it, expect, vi } from "vitest";

// RED: this symbol does not exist yet. The expert-developer adds
// `publishMatchFeedback` to packages/nats-client-ts/src/publish.ts.
import { publishMatchFeedback } from "../src/publish.js";

const SUBJECT = "p2p.v1.searches.match_feedback";

// A real human buy-file slug (matches ^[a-z0-9][a-z0-9._-]{0,119}$). NOT a UUID.
const SEARCH_SLUG = "vintage-camera_01";
// A listing id that is deliberately NOT a UUID v4 — the marketplace schema
// accepts a bounded string (1..64) here and re-reads the Listing row as the
// real gate. The helper MUST accept this; copying the channel-message
// UUID-v4 guard would wrongly reject it.
const NON_UUID_LISTING_ID = "listing-7f3a";

interface CapturedPublish {
  subject: string;
  data: Uint8Array;
  opts?: { msgID?: string };
}

function jsStub(captures: CapturedPublish[]): JetStreamClient {
  return {
    publish: vi.fn(
      async (subject: string, data: Uint8Array, opts?: { msgID?: string }) => {
        captures.push({ subject, data, opts });
        return { seq: captures.length };
      },
    ),
  } as unknown as JetStreamClient;
}

function decodeBody(c: CapturedPublish): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(c.data)) as Record<string, unknown>;
}

describe("publishMatchFeedback — pursue → outcome 'pursued'", () => {
  it("publishes exactly one message on p2p.v1.searches.match_feedback", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
      actionOnMatch: "notify",
    });
    expect(captures.length).toBe(1);
    expect(captures[0].subject).toBe(SUBJECT);
  });

  it("body is EXACTLY {search_slug, listing_id, outcome, action_on_match} — no label, no summary, no extras", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
      actionOnMatch: "notify",
    });
    const body = decodeBody(captures[0]);
    expect(body).toEqual({
      search_slug: SEARCH_SLUG,
      listing_id: NON_UUID_LISTING_ID,
      outcome: "pursued",
      action_on_match: "notify",
    });
    // Explicit trust-boundary assertions — the body keys are a closed set.
    expect(Object.keys(body).sort()).toEqual([
      "action_on_match",
      "listing_id",
      "outcome",
      "search_slug",
    ]);
    expect("label" in body).toBe(false);
    expect("listing_summary" in body).toBe(false);
  });
});

describe("publishMatchFeedback — dismiss → outcome 'dismissed'", () => {
  it("carries outcome 'dismissed' with the same (search_slug, listing_id); label never sent", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "dismissed",
      actionOnMatch: "notify",
    });
    const body = decodeBody(captures[0]);
    expect(body["outcome"]).toBe("dismissed");
    expect(body["search_slug"]).toBe(SEARCH_SLUG);
    expect(body["listing_id"]).toBe(NON_UUID_LISTING_ID);
    // The ± label is server-derived (to hard_negative) — never on the wire.
    expect("label" in body).toBe(false);
    expect(body["outcome"]).not.toBe("hard_negative");
    expect(body["outcome"]).not.toBe("negative");
  });
});

describe("publishMatchFeedback — action_on_match provenance is reported honestly", () => {
  it("a negotiate-mode search emits action_on_match 'negotiate' (NOT rewritten to notify)", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
      actionOnMatch: "negotiate",
    });
    const body = decodeBody(captures[0]);
    // Reporting `negotiate` honestly (knowing curation will drop it) is
    // correct. Rewriting it to `notify` to "save" the signal poisons the
    // corpus — the helper must pass the real mode through.
    expect(body["action_on_match"]).toBe("negotiate");
  });

  it("omits action_on_match from the body when not provided (optional provenance)", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
    });
    const body = decodeBody(captures[0]);
    // action_on_match is Type.Optional — when absent the field must not be
    // emitted as null/undefined; the marketplace defaults it server-side.
    expect("action_on_match" in body).toBe(false);
  });
});

describe("publishMatchFeedback — idempotent re-emit with a fresh dedup id", () => {
  it("each publish carries a fresh client-minted event_id as the Nats-Msg-Id header", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    // First verdict, then a redelivered wake / flipped verdict re-emits.
    const first = await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
      actionOnMatch: "notify",
    });
    const second = await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "dismissed",
      actionOnMatch: "notify",
    });
    expect(captures.length).toBe(2);
    // The dedup header is the minted event_id (matching the channel-message
    // helper's Nats-Msg-Id contract).
    expect(captures[0].opts?.msgID).toBe(first.event_id);
    expect(captures[1].opts?.msgID).toBe(second.event_id);
    // A flipped verdict is a genuinely new event — fresh id, not reused.
    expect(first.event_id).not.toBe(second.event_id);
    // The emit requires NO local memory of the prior verdict: the second call
    // had identical (slug, listing) and still published a fresh message.
    expect(captures[1].subject).toBe(SUBJECT);
  });

  it("event_id is a non-empty string returned to the caller", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    const ack = await publishMatchFeedback({
      js,
      searchSlug: SEARCH_SLUG,
      listingId: NON_UUID_LISTING_ID,
      outcome: "pursued",
      actionOnMatch: "notify",
    });
    expect(typeof ack.event_id).toBe("string");
    expect(ack.event_id.length).toBeGreaterThan(0);
  });
});

describe("publishMatchFeedback — body ids are validated as slug/bounded-string, NOT UUID-v4", () => {
  it("ACCEPTS a non-UUID listing_id (the helper must NOT reuse the channel-message UUID guard)", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    // This is the explicit assertion: a non-UUID listing_id must NOT be
    // rejected — it rides in the body, not a subject path, and the
    // marketplace accepts a bounded string.
    await expect(
      publishMatchFeedback({
        js,
        searchSlug: SEARCH_SLUG,
        listingId: NON_UUID_LISTING_ID,
        outcome: "pursued",
        actionOnMatch: "notify",
      }),
    ).resolves.toBeDefined();
    expect(captures.length).toBe(1);
    expect(decodeBody(captures[0])["listing_id"]).toBe(NON_UUID_LISTING_ID);
  });

  it("ACCEPTS a slug-shaped search_slug containing dots, dashes, underscores", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await expect(
      publishMatchFeedback({
        js,
        searchSlug: "a.b-c_d0",
        listingId: NON_UUID_LISTING_ID,
        outcome: "dismissed",
        actionOnMatch: "notify",
      }),
    ).resolves.toBeDefined();
    expect(decodeBody(captures[0])["search_slug"]).toBe("a.b-c_d0");
  });

  it("REJECTS an out-of-set outcome before any wire write (closed set enforced)", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    await expect(
      publishMatchFeedback({
        js,
        searchSlug: SEARCH_SLUG,
        listingId: NON_UUID_LISTING_ID,
        // @ts-expect-error — deliberately invalid outcome; the helper must reject it.
        outcome: "positive",
        actionOnMatch: "notify",
      }),
    ).rejects.toThrow();
    expect(captures.length).toBe(0);
  });

  it("REJECTS a subject-injection / empty search_slug before any wire write", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    for (const bad of ["", "Has Space", "UPPER", "a".repeat(200)]) {
      await expect(
        publishMatchFeedback({
          js,
          searchSlug: bad,
          listingId: NON_UUID_LISTING_ID,
          outcome: "pursued",
          actionOnMatch: "notify",
        }),
      ).rejects.toThrow();
    }
    expect(captures.length).toBe(0);
  });

  it("REJECTS an empty or over-long (>64) listing_id before any wire write", async () => {
    const captures: CapturedPublish[] = [];
    const js = jsStub(captures);
    for (const bad of ["", "x".repeat(65)]) {
      await expect(
        publishMatchFeedback({
          js,
          searchSlug: SEARCH_SLUG,
          listingId: bad,
          outcome: "pursued",
          actionOnMatch: "notify",
        }),
      ).rejects.toThrow();
    }
    expect(captures.length).toBe(0);
  });
});
