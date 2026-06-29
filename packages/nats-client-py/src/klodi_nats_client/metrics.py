"""KlodiClient metrics surface — P2-27.

Per-client counters exposed to operator dashboards (and to the Rust
daemons' ``--health-port /metrics`` Prometheus exporter, which uses the
same counter names). Counters are monotonic within a process lifetime;
restart resets them all to 0.

Mirrors ``packages/nats-client-ts/src/metrics.ts`` and
``packages/nats-client-rs/src/metrics.rs`` so the names + semantics are
comparable across all three clients.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ClientMetrics:
    """Read-only snapshot of all counters at a point in time.

    Frozen by design — increments happen via :class:`MutableMetrics`
    on the consumer hot path and are surfaced through
    :attr:`KlodiClient.metrics` as a fresh snapshot per access.
    """

    consumed: int
    acked: int
    naked: int
    dedup_hit: int
    redelivery_count: int
    pending_count: int
    # Times the consume loop re-bound its pull subscription after a
    # transport flap. A non-zero, climbing value means the transport is
    # flapping; a value that climbs without ``consumed`` advancing means a
    # consumer that re-binds but never resumes — the wedge INV-1 forbids.
    resubscribe: int


class MutableMetrics:
    """Internal mutable counters. Public read view is the snapshot."""

    __slots__ = (
        "_consumed",
        "_acked",
        "_naked",
        "_dedup_hit",
        "_redelivery_count",
        "_pending_count",
        "_resubscribe",
    )

    def __init__(self) -> None:
        self._consumed = 0
        self._acked = 0
        self._naked = 0
        self._dedup_hit = 0
        self._redelivery_count = 0
        self._pending_count = 0
        self._resubscribe = 0

    def inc_consumed(self) -> None:
        self._consumed += 1

    def inc_acked(self) -> None:
        self._acked += 1

    def inc_naked(self) -> None:
        self._naked += 1

    def inc_dedup_hit(self) -> None:
        self._dedup_hit += 1

    def inc_resubscribe(self) -> None:
        """Count an in-place pull-subscription re-bind after a flap."""
        self._resubscribe += 1

    def add_redelivery(self, count: int) -> None:
        """Add the message's redelivery count (0 for first delivery)."""
        if count > 0:
            self._redelivery_count += count

    def set_pending(self, count: int) -> None:
        """Replace the pending-count gauge with a fresh snapshot."""
        if count >= 0:
            self._pending_count = count

    def snapshot(self) -> ClientMetrics:
        """Return an immutable read view of all counters."""
        return ClientMetrics(
            consumed=self._consumed,
            acked=self._acked,
            naked=self._naked,
            dedup_hit=self._dedup_hit,
            redelivery_count=self._redelivery_count,
            pending_count=self._pending_count,
            resubscribe=self._resubscribe,
        )


__all__ = ["ClientMetrics", "MutableMetrics"]
