/**
 * Per-conversation wake-session keying for openclaw.
 *
 * Direct port of the frozen hermes scheme
 * (`adapters/hermes/src/klodi_hermes/wake_handlers.py::derive_wake_session`)
 * recorded in **ADR-0019** ("Wake session model — per-conversation,
 * `klodi:`-namespaced"). One marketplace conversation maps to exactly one wake
 * session, derived deterministically from the event entity — keyed off the
 * kind's DOMAIN prefix (`_SESSION_KEY_FIELD_BY_DOMAIN`), NOT "first id present":
 *
 *   channel.*                     → channel_id
 *   offer.* · comment.created · listing.* → listing_id
 *   transaction.*                 → transaction_id
 *   search.match                  → search_slug
 *   mapped field empty / unmapped → wake-<event_id> (or wake-<uuid4>)
 *
 * The key carries the runtime-required `agent:<agentId>:` prefix (the heartbeat
 * runtime routes forced wakes by it — wake.ts invariant #4) with the entity
 * scoped inside the `klodi:` namespace (BR-5 separability): `agent:<agentId>:klodi:<entity_id>`.
 */

import { randomUUID } from "node:crypto";

import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";

/**
 * Namespace segment on EVERY wake-session key. Lets the outbound/operator-session
 * resolver exclude the whole wake-session family by this prefix (BR-5). A bare
 * entity id — especially a `search_slug` like `vintage-camera` — is otherwise
 * indistinguishable from a session a human operator owns.
 */
export const WAKE_SESSION_NAMESPACE = "klodi:" as const;

/**
 * Per-domain session-key field, keyed off the kind's DOMAIN prefix
 * (`kind.split(".")[0]`), NOT "first id present". Mirrors the frozen hermes
 * `_SESSION_KEY_FIELD_BY_DOMAIN` (ADR-0019): several kinds carry more than one
 * id (`offer.accepted` has both `listing_id` and `transaction_id`), so only the
 * prefix is authoritative — `offer.*` / `comment.*` / `listing.*` all scope to
 * the LISTING.
 */
const SESSION_KEY_FIELD_BY_DOMAIN: Readonly<Record<string, string | undefined>> = {
  channel: "channel_id",
  offer: "listing_id",
  comment: "listing_id",
  listing: "listing_id",
  transaction: "transaction_id",
  search: "search_slug",
};

/**
 * Derive the per-conversation session key for a wake.
 *
 * Shape: `agent:<agentId>:klodi:<entity_id>`. A mapped key field that is
 * absent/empty (or an unmapped domain) falls back to a bounded per-wake
 * `wake-<event_id>` ephemeral id (or `wake-<uuid4>` if `event_id` is also
 * absent) — NEVER a shared constant. A marketplace-supplied id that contains a
 * path separator or starts with `.` is REFUSED (throws), mirroring hermes
 * `_reject_traversal_entity_id` (THREAT_MODEL T5). Note the deliberate
 * per-language asymmetry: the Rust port folds refusal into the safe ephemeral
 * fallback (its `-> String` signature cannot raise); both satisfy BR-4.
 */
export function deriveWakeSessionKey(
  agentId: string,
  event: NotificationEvent | ChannelMessageEvent,
): string {
  const entityId = extractEntityId(event);
  if (entityId !== undefined) {
    rejectTraversalEntityId(entityId);
    return sessionKey(agentId, entityId);
  }
  // Bounded per-wake fallback — never a shared constant (BR-3).
  const fallback = `wake-${event.event_id !== "" ? event.event_id : randomUUID()}`;
  return sessionKey(agentId, fallback);
}

function sessionKey(agentId: string, entityId: string): string {
  return `agent:${agentId}:${WAKE_SESSION_NAMESPACE}${entityId}`;
}

/**
 * The conversation entity id a wake scopes to, keyed off the event's DOMAIN
 * (ADR-0019). `undefined` when the mapped field is absent/empty or the domain
 * is unmapped — the caller then uses the ephemeral fallback.
 */
function extractEntityId(
  event: NotificationEvent | ChannelMessageEvent,
): string | undefined {
  const domain = event.kind.split(".")[0] ?? "";
  const keyField = SESSION_KEY_FIELD_BY_DOMAIN[domain];
  if (keyField === undefined) return undefined;
  // Structural read of the typed union by a runtime-resolved field name — the
  // value is re-validated as a non-empty string below, so no `any` escapes.
  const value = (event as unknown as Record<string, unknown>)[keyField];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Refuse a marketplace-supplied id that is not a single safe path component —
 * a poisoned id must never become a `--session klodi:../…` arg or a derived
 * filename (THREAT_MODEL T5). Mirrors hermes `_reject_traversal_entity_id`.
 */
function rejectTraversalEntityId(entityId: string): void {
  if (
    entityId.includes("/")
    || entityId.includes("\\")
    || entityId.startsWith(".")
  ) {
    throw new Error(
      `unsafe marketplace entity id ${JSON.stringify(entityId)}: must not`
      + " contain a path separator or start with '.'",
    );
  }
}
