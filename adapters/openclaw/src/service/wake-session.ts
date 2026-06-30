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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * qa-developer STUB — card/openclaw-zeroclaw-per-conversation-wake-keying (RED).
 *
 * Returns a deliberately-wrong constant so the keying tests in
 * `__tests__/service/wake-session.test.ts` fail RED at runtime (distinctness /
 * domain-prefix / fallback) and the traversal-refusal test fails RED (no throw).
 * The expert-developer REPLACES the body with the real derivation; the
 * `WAKE_SESSION_NAMESPACE` const and the public signature
 * `deriveWakeSessionKey(agentId, event) -> string` are the frozen contract.
 * Do NOT edit the test file — those tests are the spec.
 * ─────────────────────────────────────────────────────────────────────────────
 */

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
 * Derive the per-conversation session key for a wake.
 *
 * Shape: `agent:<agentId>:klodi:<entity_id>`. A mapped key field that is
 * absent/empty (or an unmapped domain) falls back to a bounded per-wake
 * `wake-<event_id>` ephemeral id (or `wake-<uuid4>` if `event_id` is also
 * absent) — NEVER a shared constant. A marketplace-supplied id that contains a
 * path separator or starts with `.` is REFUSED (throws), mirroring hermes
 * `_reject_traversal_entity_id` (THREAT_MODEL T5).
 */
export function deriveWakeSessionKey(
  agentId: string,
  event: NotificationEvent | ChannelMessageEvent,
): string {
  // qa stub — expert-developer replaces. See the module-level STUB note.
  void agentId;
  void event;
  return "agent:STUB:klodi:STUB";
}
