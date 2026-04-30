/**
 * Exponential reconnect backoff with jitter — P2-5.
 *
 * The nats-core defaults are flat (`reconnectTimeWait: 2_000`) which
 * thunders the herd when a multi-replica server recovers from a
 * multi-hour outage: every client retries on the same 2s grid. This
 * module computes per-attempt delays as
 *
 *   base * multiplier^(attempt - 1)
 *
 * capped at `capMs`, then perturbed by a uniform jitter in
 * `[-jitterRatio, +jitterRatio]` of the computed value. The cap is
 * applied **before** jitter so the post-jitter value can briefly exceed
 * the cap by up to `jitterRatio * capMs` — that's intentional, the cap
 * is a target ceiling for the deterministic component, not a hard cap on
 * any single delay.
 *
 * Mirrors the Python `klodi_nats_client.backoff` and Rust
 * `klodi_nats_client::backoff` helpers — shared semantics across all
 * three clients per the cross-language symmetry contract (R § theme 2).
 */

export interface BackoffConfig {
  /** First-attempt delay in milliseconds. Default 250ms. */
  readonly baseMs: number;
  /** Per-attempt multiplier. Default 2 (doubles each attempt). */
  readonly multiplier: number;
  /**
   * Upper bound on the deterministic delay before jitter, in
   * milliseconds. Default 60_000 (60s). The post-jitter delay can
   * briefly exceed this by up to `jitterRatio * capMs`.
   */
  readonly capMs: number;
  /**
   * Symmetric jitter as a fraction of the (capped) delay. Default 0.25.
   * The actual jitter is sampled uniformly from [-jitterRatio, +jitterRatio].
   */
  readonly jitterRatio: number;
  /** Random source. Defaults to `Math.random`. Injectable for tests. */
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF_CONFIG: Readonly<Omit<BackoffConfig, "random">> = {
  baseMs: 250,
  multiplier: 2,
  capMs: 60_000,
  jitterRatio: 0.25,
};

/**
 * Compute the delay (in ms) for a given reconnect `attempt` (1-based).
 *
 * Examples (deterministic / pre-jitter):
 *   attempt=1 → 250ms
 *   attempt=2 → 500ms
 *   attempt=3 → 1000ms
 *   ...
 *   attempt=9 → 64000ms → capped to 60000ms
 *
 * Jitter adds ±25% (default) on top of the capped value.
 *
 * @throws if `attempt < 1`.
 */
export function computeBackoffMs(
  attempt: number,
  config: Partial<BackoffConfig> = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `computeBackoffMs: attempt must be a positive integer, got ${attempt}`,
    );
  }
  const merged = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  const random = config.random ?? Math.random;
  const exponent = attempt - 1;
  const raw = merged.baseMs * Math.pow(merged.multiplier, exponent);
  const capped = Math.min(raw, merged.capMs);
  // Uniform sample in [-jitterRatio, +jitterRatio].
  const jitterFraction = (random() * 2 - 1) * merged.jitterRatio;
  const delay = capped * (1 + jitterFraction);
  // Floor at 0 — negative jitter on a small base shouldn't underflow
  // into a busy-loop (the library re-checks immediately).
  return Math.max(0, delay);
}
