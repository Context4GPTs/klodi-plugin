"""Unit tests for ``klodi_nats_client.backoff`` (P2-5).

Asserts: monotonic increase up to the cap, the cap holds at high
attempt counts, and jitter is constrained to ±25% across many samples.
The random source is injected so tests are deterministic — no real
``random.random`` calls.
"""

from __future__ import annotations

import pytest

from klodi_nats_client.backoff import (
    BackoffPolicy,
    DEFAULT_BASE_SECONDS,
    DEFAULT_CAP_SECONDS,
    DEFAULT_JITTER_RATIO,
    compute_backoff_seconds,
)


def _no_jitter() -> float:
    """Random source that returns 0.5 → jitter fraction = 0."""
    return 0.5


def test_rejects_zero_attempt() -> None:
    with pytest.raises(ValueError):
        compute_backoff_seconds(0)


def test_rejects_negative_attempt() -> None:
    with pytest.raises(ValueError):
        compute_backoff_seconds(-3)


def test_attempt_one_returns_base_with_no_jitter() -> None:
    delay = compute_backoff_seconds(1, rng=_no_jitter)
    assert delay == DEFAULT_BASE_SECONDS


def test_doubles_deterministically_until_cap() -> None:
    expected = [0.250, 0.500, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0]
    for idx, ms in enumerate(expected):
        assert compute_backoff_seconds(idx + 1, rng=_no_jitter) == ms


def test_caps_at_60s_on_overflow_attempts() -> None:
    # 0.250 * 2^9 = 128s > 60s cap.
    assert compute_backoff_seconds(10, rng=_no_jitter) == DEFAULT_CAP_SECONDS
    assert compute_backoff_seconds(50, rng=_no_jitter) == DEFAULT_CAP_SECONDS


def test_monotonic_pre_cap_then_flat() -> None:
    prior = 0.0
    for attempt in range(1, 10):
        value = compute_backoff_seconds(attempt, rng=_no_jitter)
        assert value > prior, f"non-monotonic at attempt {attempt}: {prior}->{value}"
        prior = value
    assert compute_backoff_seconds(11, rng=_no_jitter) == DEFAULT_CAP_SECONDS


@pytest.mark.parametrize("attempt", [1, 5, 50])
def test_jitter_within_band_across_100_samples(attempt: int) -> None:
    """For 100 deterministic random samples spanning [0,1), the
    post-jitter delay must stay inside ±jitter_ratio of the capped
    value. Walks through 100 evenly-spaced rng outputs so the assertion
    is reproducible without relying on the RNG distribution.
    """
    counter = {"i": 0}

    def stepped_rng() -> float:
        i = counter["i"]
        counter["i"] = i + 1
        return i / 100.0  # 0, 0.01, 0.02, ..., 0.99

    raw = DEFAULT_BASE_SECONDS * (2.0 ** (attempt - 1))
    capped = min(raw, DEFAULT_CAP_SECONDS)
    lower = capped * (1.0 - DEFAULT_JITTER_RATIO)
    upper = capped * (1.0 + DEFAULT_JITTER_RATIO)

    for _ in range(100):
        value = compute_backoff_seconds(attempt, rng=stepped_rng)
        assert lower <= value <= upper, (
            f"attempt={attempt} value={value} not in [{lower}, {upper}]"
        )


def test_never_returns_negative_with_extreme_jitter() -> None:
    # rng=0.0 → jitter fraction = -jitter_ratio; capped value floored at 0.
    value = compute_backoff_seconds(1, rng=lambda: 0.0)
    assert value >= 0.0


def test_backoff_policy_advances_attempt_on_each_call() -> None:
    policy = BackoffPolicy(rng=_no_jitter)
    assert policy.attempt == 0
    d1 = policy.next_delay()
    d2 = policy.next_delay()
    d3 = policy.next_delay()
    assert policy.attempt == 3
    assert d1 == DEFAULT_BASE_SECONDS
    assert d2 == DEFAULT_BASE_SECONDS * 2
    assert d3 == DEFAULT_BASE_SECONDS * 4


def test_backoff_policy_reset_returns_to_base() -> None:
    policy = BackoffPolicy(rng=_no_jitter)
    policy.next_delay()
    policy.next_delay()
    policy.next_delay()
    policy.reset()
    assert policy.attempt == 0
    assert policy.next_delay() == DEFAULT_BASE_SECONDS
