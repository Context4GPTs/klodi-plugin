//! Exponential reconnect backoff with jitter — P2-5.
//!
//! Wired into [`KlodiClient::connect`](crate::client::KlodiClient::connect)
//! via `async-nats`'s [`ConnectOptions::reconnect_delay_callback`]. The
//! default `connector::reconnect_delay_callback_default` thunders the
//! herd when a multi-replica server recovers from a multi-hour outage:
//! every client retries on the same fixed grid. This module computes
//! per-attempt delays as
//!
//! ```text
//! base * multiplier^(attempt - 1)
//! ```
//!
//! capped at [`DEFAULT_CAP`], then perturbed by a uniform jitter in
//! `[-jitter_ratio, +jitter_ratio]` of the computed value.
//!
//! Mirrors `klodi-plugin/packages/nats-client-ts/src/backoff.ts` and
//! `klodi-plugin/packages/nats-client-py/src/klodi_nats_client/backoff.py`
//! so the three NATS clients agree on retry pacing.
//!
//! The `RandomSource` indirection lets unit tests inject deterministic
//! "random" values; production uses [`thread_rng`] internally.

use std::time::Duration;

/// First-attempt delay.
pub const DEFAULT_BASE: Duration = Duration::from_millis(250);

/// Multiplicative factor between attempts.
pub const DEFAULT_MULTIPLIER: f64 = 2.0;

/// Upper bound on the deterministic delay before jitter (60s).
pub const DEFAULT_CAP: Duration = Duration::from_secs(60);

/// Symmetric jitter as a fraction of the (capped) delay.
pub const DEFAULT_JITTER_RATIO: f64 = 0.25;

/// Configuration for [`compute_backoff`]. All fields have sensible
/// defaults via [`BackoffConfig::default`]; deviate only when porting
/// to a non-NATS workload.
#[derive(Clone, Copy, Debug)]
pub struct BackoffConfig {
    pub base: Duration,
    pub multiplier: f64,
    pub cap: Duration,
    pub jitter_ratio: f64,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base: DEFAULT_BASE,
            multiplier: DEFAULT_MULTIPLIER,
            cap: DEFAULT_CAP,
            jitter_ratio: DEFAULT_JITTER_RATIO,
        }
    }
}

/// Compute the delay for a 1-based reconnect `attempt`.
///
/// `random_unit` must produce a value in `[0.0, 1.0)` — the same
/// contract as [`rand::random::<f64>`]. Tests inject a deterministic
/// stub; production passes `rand::random::<f64>()`.
///
/// Examples (deterministic, no jitter / `random_unit = 0.5`):
///
/// * `attempt=1` → 250ms
/// * `attempt=2` → 500ms
/// * `attempt=3` → 1000ms
/// * `attempt=9` → 64s → capped to 60s
///
/// # Panics
///
/// Panics on `attempt == 0`. Callers in the connect path always start
/// at 1, so this signals a programming bug.
pub fn compute_backoff(
    attempt: u32,
    config: BackoffConfig,
    random_unit: f64,
) -> Duration {
    assert!(attempt >= 1, "compute_backoff: attempt must be >= 1");
    let base_ms = config.base.as_millis() as f64;
    let cap_ms = config.cap.as_millis() as f64;
    let raw = base_ms * config.multiplier.powi((attempt - 1) as i32);
    let capped = raw.min(cap_ms);
    let jitter_fraction = (random_unit * 2.0 - 1.0) * config.jitter_ratio;
    let delay = capped * (1.0 + jitter_fraction);
    Duration::from_millis(delay.max(0.0) as u64)
}

/// Production callback wired into [`ConnectOptions::reconnect_delay_callback`].
///
/// `attempts` from `async-nats` is 0-based on the very first attempt
/// (no successful connect yet) — translate by `+ 1` so the formula
/// matches the cross-language convention.
pub fn default_reconnect_delay(attempts: usize) -> Duration {
    // `async-nats` is loose on the upper bound — clamp to u32::MAX so
    // the `as i32` in `powi` can't wrap; in practice this saturates
    // at the cap long before u32::MAX matters.
    let attempt = (attempts.saturating_add(1)).min(u32::MAX as usize) as u32;
    compute_backoff(attempt, BackoffConfig::default(), rand_unit())
}

#[cfg(not(test))]
fn rand_unit() -> f64 {
    use rand::Rng;
    rand::thread_rng().gen::<f64>()
}

#[cfg(test)]
fn rand_unit() -> f64 {
    // Deterministic in tests — exercise the production callback without
    // pulling in a global RNG. The dedicated unit tests inject their
    // own random source via [`compute_backoff`] directly.
    0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_jitter() -> f64 {
        0.5
    }

    #[test]
    #[should_panic(expected = "attempt must be >= 1")]
    fn zero_attempt_panics() {
        compute_backoff(0, BackoffConfig::default(), no_jitter());
    }

    #[test]
    fn attempt_one_returns_base_with_no_jitter() {
        let d = compute_backoff(1, BackoffConfig::default(), no_jitter());
        assert_eq!(d, DEFAULT_BASE);
    }

    #[test]
    fn doubles_deterministically_until_cap() {
        let cfg = BackoffConfig::default();
        let expected_ms = [250u64, 500, 1000, 2000, 4000, 8000, 16000, 32000];
        for (idx, ms) in expected_ms.iter().enumerate() {
            let d = compute_backoff(idx as u32 + 1, cfg, no_jitter());
            assert_eq!(d.as_millis() as u64, *ms, "attempt {}", idx + 1);
        }
    }

    #[test]
    fn caps_at_60s_on_overflow_attempts() {
        let cfg = BackoffConfig::default();
        // 250ms * 2^9 = 128s > 60s cap.
        assert_eq!(compute_backoff(10, cfg, no_jitter()), DEFAULT_CAP);
        assert_eq!(compute_backoff(50, cfg, no_jitter()), DEFAULT_CAP);
    }

    #[test]
    fn monotonic_pre_cap_then_flat() {
        let cfg = BackoffConfig::default();
        let mut prior = Duration::from_secs(0);
        for attempt in 1..=9 {
            let value = compute_backoff(attempt, cfg, no_jitter());
            assert!(value > prior, "non-monotonic at attempt {attempt}");
            prior = value;
        }
        assert_eq!(compute_backoff(11, cfg, no_jitter()), DEFAULT_CAP);
    }

    fn step_through_jitter(attempt: u32, samples: usize) -> Vec<Duration> {
        let cfg = BackoffConfig::default();
        (0..samples)
            .map(|i| {
                let r = i as f64 / samples as f64;
                compute_backoff(attempt, cfg, r)
            })
            .collect()
    }

    #[test]
    fn jitter_within_band_across_100_samples_small_attempt() {
        let cfg = BackoffConfig::default();
        let raw_ms = cfg.base.as_millis() as f64;
        let lower_ms = (raw_ms * (1.0 - cfg.jitter_ratio)) as u64;
        let upper_ms = (raw_ms * (1.0 + cfg.jitter_ratio)) as u64;
        for d in step_through_jitter(1, 100) {
            let ms = d.as_millis() as u64;
            assert!(ms >= lower_ms, "{ms} < {lower_ms}");
            assert!(ms <= upper_ms, "{ms} > {upper_ms}");
        }
    }

    #[test]
    fn jitter_within_band_across_100_samples_capped_attempt() {
        let cfg = BackoffConfig::default();
        let cap_ms = cfg.cap.as_millis() as f64;
        let lower_ms = (cap_ms * (1.0 - cfg.jitter_ratio)) as u64;
        let upper_ms = (cap_ms * (1.0 + cfg.jitter_ratio)) as u64;
        for d in step_through_jitter(50, 100) {
            let ms = d.as_millis() as u64;
            assert!(ms >= lower_ms, "{ms} < {lower_ms}");
            assert!(ms <= upper_ms, "{ms} > {upper_ms}");
        }
    }

    #[test]
    fn never_returns_negative_duration() {
        // random_unit=0.0 → jitter fraction = -jitter_ratio (most negative).
        let d = compute_backoff(1, BackoffConfig::default(), 0.0);
        assert!(d >= Duration::from_millis(0));
    }

    #[test]
    fn default_reconnect_delay_returns_base_on_first_attempt() {
        // `attempts` = 0 corresponds to attempt 1 of the formula.
        let d = default_reconnect_delay(0);
        // With deterministic test rng=0.5 → no jitter → exact base.
        assert_eq!(d, DEFAULT_BASE);
    }

    #[test]
    fn default_reconnect_delay_caps_at_60s() {
        // attempts=1000 → attempt=1001 → 250 * 2^1000 way over cap.
        let d = default_reconnect_delay(1000);
        assert_eq!(d, DEFAULT_CAP);
    }
}
