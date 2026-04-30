"""Exponential reconnect backoff with jitter — P2-5.

Mirrors ``packages/nats-client-ts/src/backoff.ts`` and
``packages/nats-client-rs/src/backoff.rs`` so the three NATS clients
agree on retry pacing under sustained outage. Per **R § cross-cutting
theme 2** symmetry across the clients is asserted by code-review today
— this module makes the contract explicit and unit-testable.

The Python ``nats-py`` library does not expose a per-attempt delay
callback (its reconnect loop uses a flat ``reconnect_time_wait`` value).
We therefore expose ``compute_backoff_seconds`` for callers that wrap
their initial connect in an outer retry loop, plus a ``BackoffPolicy``
mutable counter for integrators that want a stateful cursor.
"""

from __future__ import annotations

import random as _random
from dataclasses import dataclass
from typing import Callable, Final


# Defaults match the TS / Rust analogs by spec. See **R § P2-5**.

#: First-attempt delay, in seconds.
DEFAULT_BASE_SECONDS: Final[float] = 0.250

#: Multiplicative factor between attempts.
DEFAULT_MULTIPLIER: Final[float] = 2.0

#: Upper bound on the deterministic delay before jitter, in seconds.
DEFAULT_CAP_SECONDS: Final[float] = 60.0

#: Symmetric jitter as a fraction of the (capped) delay.
DEFAULT_JITTER_RATIO: Final[float] = 0.25


def compute_backoff_seconds(
    attempt: int,
    *,
    base_seconds: float = DEFAULT_BASE_SECONDS,
    multiplier: float = DEFAULT_MULTIPLIER,
    cap_seconds: float = DEFAULT_CAP_SECONDS,
    jitter_ratio: float = DEFAULT_JITTER_RATIO,
    rng: Callable[[], float] = _random.random,
) -> float:
    """Compute the delay (in seconds) for a 1-based reconnect ``attempt``.

    Examples (deterministic, no jitter):

    * ``attempt=1`` → ``0.250``
    * ``attempt=2`` → ``0.500``
    * ``attempt=3`` → ``1.000``
    * ``attempt=9`` → ``64.000`` → capped to ``60.000``

    Jitter samples uniformly from ``[-jitter_ratio, +jitter_ratio]`` of
    the capped value, so the post-jitter delay can briefly exceed the
    cap by up to ``jitter_ratio * cap_seconds``. The cap is a target
    ceiling for the deterministic component, not a hard cap on any
    single delay.

    :raises ValueError: when ``attempt < 1``.
    """
    if attempt < 1:
        raise ValueError(
            f"compute_backoff_seconds: attempt must be >= 1, got {attempt}"
        )
    raw = base_seconds * (multiplier ** (attempt - 1))
    capped = min(raw, cap_seconds)
    # Uniform sample in [-jitter_ratio, +jitter_ratio].
    jitter_fraction = (rng() * 2.0 - 1.0) * jitter_ratio
    delay = capped * (1.0 + jitter_fraction)
    # Floor at 0 — negative jitter on a small base shouldn't underflow
    # into a busy-loop.
    return max(0.0, delay)


@dataclass
class BackoffPolicy:
    """Stateful cursor wrapping ``compute_backoff_seconds``.

    Use case: outer retry loop that needs to remember "what attempt are
    we on?" and reset on success without the caller threading the
    counter through. The counter advances on every ``next_delay()`` call
    and resets to 0 on ``reset()``.

    Mirrors the `KlodiClient.reconnectAttempt` cursor in the TS client
    and the analogous field in Rust's connect path.
    """

    base_seconds: float = DEFAULT_BASE_SECONDS
    multiplier: float = DEFAULT_MULTIPLIER
    cap_seconds: float = DEFAULT_CAP_SECONDS
    jitter_ratio: float = DEFAULT_JITTER_RATIO
    rng: Callable[[], float] = _random.random
    _attempt: int = 0

    def next_delay(self) -> float:
        """Advance the attempt counter and return the next delay."""
        self._attempt += 1
        return compute_backoff_seconds(
            self._attempt,
            base_seconds=self.base_seconds,
            multiplier=self.multiplier,
            cap_seconds=self.cap_seconds,
            jitter_ratio=self.jitter_ratio,
            rng=self.rng,
        )

    def reset(self) -> None:
        """Reset the attempt counter to 0 — call after a successful connect."""
        self._attempt = 0

    @property
    def attempt(self) -> int:
        """Current attempt number (0 before the first ``next_delay()``)."""
        return self._attempt


__all__ = [
    "BackoffPolicy",
    "DEFAULT_BASE_SECONDS",
    "DEFAULT_CAP_SECONDS",
    "DEFAULT_JITTER_RATIO",
    "DEFAULT_MULTIPLIER",
    "compute_backoff_seconds",
]
