#!/usr/bin/env python3
"""Cross-language wire test publisher (Py half).

Per **R § P2-9**: TS / Py / Rust ``publish_channel_message`` MUST emit
byte-equivalent wire output for the same logical event. This script is
the Python publisher half — it builds the production channel-message
body with externally-supplied (deterministic) inputs and publishes
once to a designated subject. The orchestrator at
``tests/integration/cross-language-wire/orchestrator.py`` drives all
three publishers with the same inputs and asserts byte-equivalence
after subscription capture.

Why bypass ``publish_channel_message``'s built-in event_id /
message_id minting: the contract under test is "given the same inputs,
all three serializers produce the same JSON bytes". The randomness
inside the production helper is correct for production but defeats a
wire-equivalence test. The body assembly + serializer choice is what's
under test here — and this script mirrors the production layout in
``src/klodi_nats_client/publish.py`` field-for-field.

Usage (driven by orchestrator.py):
  python publish_canonical.py --nats-url <url> --creds-path <path> \
    --subject <subject> --channel-id <id> --sender-user-id <id> \
    --sender-handle <handle> --content <content> \
    --event-id <id> --message-id <id> --created-at <iso8601>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import nats


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish a canonical channel.message body to NATS",
    )
    parser.add_argument("--nats-url", required=True)
    parser.add_argument("--creds-path", required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--channel-id", required=True)
    parser.add_argument("--sender-user-id", required=True)
    parser.add_argument("--sender-handle", required=True)
    parser.add_argument("--content", required=True)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--message-id", required=True)
    parser.add_argument("--created-at", required=True)
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> None:
    creds_path = Path(args.creds_path)
    if not creds_path.is_file():
        raise FileNotFoundError(f"creds not found: {creds_path}")

    nc = await nats.connect(
        servers=args.nats_url,
        user_credentials=str(creds_path),
    )

    try:
        # Mirror publish_channel_message byte-for-byte. Field order
        # matches production (see
        # klodi-plugin/packages/nats-client-py/src/klodi_nats_client/publish.py).
        body: dict[str, Any] = {
            "kind": "channel.message",
            "event_id": args.event_id,
            "channel_id": args.channel_id,
            "message_id": args.message_id,
            "sender_user_id": args.sender_user_id,
            "sender_handle": args.sender_handle,
            "content": args.content,
            "created_at": args.created_at,
        }
        # Python 3.7+ preserves dict insertion order; json.dumps with
        # default separators produces the same UTF-8 bytes as
        # production. Use core publish (not JetStream) so the
        # orchestrator's plain subscription captures the body verbatim.
        await nc.publish(args.subject, json.dumps(body).encode("utf-8"))
        await nc.flush()
        print("py:published")
    finally:
        await nc.drain()


def main() -> int:
    args = _parse_args()
    try:
        asyncio.run(_run(args))
    except Exception as err:
        print(f"py:error {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
