#!/usr/bin/env python3
"""Cross-language ack-ordering example (Py half).

Per design Section 6 / P-ACK axis (P1-4 regression guard): under
``max_ack_pending: 1`` redelivery pressure, the per-language consume
loop MUST honor handler-completion-happens-before-ack and
next-dispatch-happens-after-ack.

Test pattern:

  1. Create a unique stream + durable consumer with
     ``ack_policy: explicit, max_ack_pending: 1``.
  2. Publish 3 messages with body ``{"seq": 0|1|2}``.
  3. Consume one at a time, awaiting each ``msg.ack()`` before
     fetching the next — same shape as the production consume loop in
     ``src/klodi_nats_client/consumers.py``.
  4. Capture nanosecond timestamps via ``time.perf_counter_ns()`` at
     received + ack_returned.
  5. Cleanup (delete stream).
  6. Print ``{"events": [...]}`` to stdout.

The orchestrator at
``tests/integration/nats-infra/cross-language-wire/orchestrator-ack.py``
asserts per-language ``ack[i].t_ns < received[i+1].t_ns``. A no-await
regression flips that ordering and surfaces as exit 2.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid

import nats
from nats.js.api import (
    AckPolicy,
    ConsumerConfig,
    DeliverPolicy,
    ReplayPolicy,
    RetentionPolicy,
    StreamConfig,
)

NUM_MESSAGES = 3
# nats-py's StreamConfig.max_age and ConsumerConfig.ack_wait fields take
# seconds (float) — the library converts to nanoseconds for the wire.
ACK_WAIT_SECONDS = 30.0
STREAM_MAX_AGE_SECONDS = 5 * 60.0


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--nats-url", required=True)
    p.add_argument("--creds-path", required=True)
    return p.parse_args()


async def _run(args: argparse.Namespace) -> None:
    nc = await nats.connect(
        servers=args.nats_url,
        user_credentials=args.creds_path,
    )

    test_id = uuid.uuid4().hex[:8]
    stream_name = f"ACK_TEST_PY_{test_id.upper()}"
    subject = f"cross.lang.ack.py.{test_id}"
    consumer_name = f"ack-test-py-{test_id}"
    events: list[dict[str, object]] = []

    try:
        js = nc.jetstream()

        await js.add_stream(
            StreamConfig(
                name=stream_name,
                subjects=[subject],
                retention=RetentionPolicy.LIMITS,
                max_age=STREAM_MAX_AGE_SECONDS,
            )
        )
        await js.add_consumer(
            stream_name,
            ConsumerConfig(
                durable_name=consumer_name,
                ack_policy=AckPolicy.EXPLICIT,
                ack_wait=ACK_WAIT_SECONDS,
                max_ack_pending=1,
                max_deliver=5,
                deliver_policy=DeliverPolicy.ALL,
                replay_policy=ReplayPolicy.INSTANT,
            ),
        )

        for i in range(NUM_MESSAGES):
            body = json.dumps({"seq": i}).encode("utf-8")
            await js.publish(
                subject, body, headers={"Nats-Msg-Id": f"msg-{test_id}-{i}"},
            )

        sub = await js.pull_subscribe_bind(consumer=consumer_name, stream=stream_name)
        for _ in range(NUM_MESSAGES):
            # Fetch one at a time so the loop blocks on ack — mirrors the
            # production consume loop's max_ack_pending=1 discipline.
            msgs = await sub.fetch(batch=1, timeout=10.0)
            for msg in msgs:
                t_recv = time.perf_counter_ns()
                payload = json.loads(msg.data.decode("utf-8"))
                events.append(
                    {"event": "received", "seq": payload["seq"], "t_ns": t_recv}
                )
                await msg.ack()
                t_ack = time.perf_counter_ns()
                events.append(
                    {"event": "ack_returned", "seq": payload["seq"], "t_ns": t_ack}
                )

        await sub.unsubscribe()

        # Cleanup so repeated runs don't accumulate streams.
        await js.delete_stream(stream_name)
    finally:
        await nc.drain()

    sys.stdout.write(json.dumps({"events": events}, separators=(",", ":")))
    sys.stdout.write("\n")


def main() -> int:
    args = _parse_args()
    try:
        asyncio.run(_run(args))
    except Exception as err:  # noqa: BLE001
        print(f"py:error {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
