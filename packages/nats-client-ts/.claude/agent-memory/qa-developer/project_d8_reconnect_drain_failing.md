---
name: D.8 reconnect-drain test failing in @klodi/nats-client (still broken after timeout fix)
description: D.8 reconnect-drain phase 2 only receives 1-2 of 3 redelivered events even after extending test budget past ack_wait
type: project
---

`tests/integration/reconnect-drain.integration.test.ts > KlodiClient reconnect + drain (D.8) > delivers remaining events in order on reconnect with no duplicates`

**State as of 2026-04-26 (after second investigation):** still failing. 20/21 integration tests pass; D.8 fails reproducibly under `INTEGRATION=1 TEST_NATS_WS_URL=ws://127.0.0.1:8080 pnpm --filter @klodi/nats-client test`.

**What was tried:**
1. Original timeout was 15s. `consumers.ts:40` defines `ACK_WAIT_NANOS = 30 * 1_000_000_000` (30s) — so a 15s budget could not cover redelivery of an in-flight message. Extended phase-2 budget from 15s → 45s and outer test timeout from 60s → 90s. Comment added at the timeout citing the ack_wait dependency.
2. With the extended budget, phase 2 still fails. Diagnostic logging (since reverted) showed: phase-2 events 1 and 2 arrive at +29996ms and +30001ms after rebind (i.e., right at ack_wait expiry, *not* immediately on rebind). Phase-2 event 3 never arrives within 45s.

**What that means:** The original simple model was wrong. With `max_ack_pending: 1` you'd expect 2 messages to be in stream-pending and drain immediately, with only 1 waiting on `ack_wait`. Instead, **all 3 remaining messages end up in `ack_pending` server-side** at phase-1 close time. They all wait for `ack_wait` to expire, then redeliver — but only 2 of the 3 actually make it to phase 2.

**Most likely cause:** `consume()`'s default pull batch (`max_messages: 100`) buffers messages client-side faster than the handler processes them. By the time the test sees 2 events processed and calls `client.close()`, the pull loop has already accepted seqs 3, 4, and 5 from the server (server momentarily allowed it because acks 1 and 2 cleared `ack_pending` to 0 in quick succession). All 3 are in client-side buffer with their server-side `ack_wait` ticking. On close they're all abandoned.

**Why only 2/3 redeliver after ack_wait is the real bug:** `max_ack_pending: 1` forces sequential redelivery server-side, but the redelivered messages should still all eventually arrive. They aren't.

**How to apply:** Do not weaken the test. The test contract ("remaining 3 events delivered in order on reconnect with no duplicates") is correct per Decision 13 row D.8 and the test docblock. The implementation is the problem. Investigate:
1. Why the phase-2 `consume()` loop receives only 2 of the 3 redelivered messages. Likely candidates: (a) ack-pending limit interaction with redelivery, (b) the new `consume()` not pulling aggressively enough after the first 2 redeliveries, (c) `MAX_DELIVER: 5` interplay if phase-1 caused multiple delivery attempts before close.
2. Whether `consume()` should be configured with a smaller `max_messages` (e.g., 1) given `max_ack_pending: 1` — this would prevent client-side over-buffering and make phase-1 close leave only 1 in ack_pending instead of 3.

**Out of scope but real:** `docker logs klodi-nats` shows 47 recovered durable consumers for `P2P_NOTIFICATIONS` on boot — orphan accumulation from prior test runs whose `afterEach deleteConsumer` was bypassed (process kills, etc.). Cleanup is best-effort per the test's `try/catch`. Stream `consumer_count: 47` confirms it via the JSZ HTTP monitor.
