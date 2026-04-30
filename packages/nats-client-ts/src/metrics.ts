/**
 * KlodiClient metrics surface — P2-27.
 *
 * Per-client counters that downstream (operator dashboard, Prometheus
 * scraper, in-process health probe) can read. Counters are monotonic
 * within a process lifetime; restart resets them all to 0.
 *
 * The metric names mirror the per-language analogs in
 * `klodi_nats_client.metrics` (Python) and `klodi_nats_client::metrics`
 * (Rust). The Prometheus exposition layer in `klodi-rust-host`'s
 * `--health-port` maps these names 1:1 to `klodi_client_*` series.
 */

/**
 * Snapshot of all counters at a point in time. Read-only — increments
 * happen via the [`KlodiMetrics`] mutator on the consumer hot path.
 */
export interface ClientMetrics {
  /** Wakes received from JetStream (pre-dedup, pre-handler). */
  readonly consumed: number;
  /** Successful `msg.ack()` count. */
  readonly acked: number;
  /** `msg.nak()` count (handler raised). */
  readonly naked: number;
  /** Wakes whose `event_id` was already in the LRU window. */
  readonly dedup_hit: number;
  /** Sum of `redelivery_count` across delivered messages. */
  readonly redelivery_count: number;
  /**
   * JetStream consumer pending count, refreshed best-effort on subscribe
   * and per-fetch. Zero until the first refresh lands.
   */
  readonly pending_count: number;
}

/**
 * Mutable counters. Internal — exposed on the client only as a
 * read-only [`ClientMetrics`] snapshot via `client.metrics`.
 */
export class KlodiMetrics {
  private _consumed = 0;
  private _acked = 0;
  private _naked = 0;
  private _dedup_hit = 0;
  private _redelivery_count = 0;
  private _pending_count = 0;

  incConsumed(): void { this._consumed += 1; }
  incAcked(): void { this._acked += 1; }
  incNaked(): void { this._naked += 1; }
  incDedupHit(): void { this._dedup_hit += 1; }
  /** Add the message's `redelivery_count` (0 for first delivery). */
  addRedelivery(count: number): void {
    if (Number.isFinite(count) && count > 0) {
      this._redelivery_count += count;
    }
  }
  /** Replace the pending-count with a fresh JetStream snapshot. */
  setPending(count: number): void {
    if (Number.isFinite(count) && count >= 0) {
      this._pending_count = count;
    }
  }

  /** Read-only snapshot. Safe to expose via `client.metrics`. */
  snapshot(): ClientMetrics {
    return {
      consumed: this._consumed,
      acked: this._acked,
      naked: this._naked,
      dedup_hit: this._dedup_hit,
      redelivery_count: this._redelivery_count,
      pending_count: this._pending_count,
    };
  }
}
