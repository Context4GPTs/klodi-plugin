//! Cross-language dedup-LRU example (Rust half).
//!
//! Per design Section 6 / P-DEDUP axis (P1-5 regression guard): the
//! in-process event_id LRU MUST evict by recency, not insertion order.
//!
//! Test pattern (capacity-agnostic — works for any LRU backed by
//! recency-aware eviction):
//!   1. Fill the LRU to capacity (N inserts).
//!   2. "Touch" id_target (one of the existing entries) by calling
//!      `get()` — `lru::LruCache::get` refreshes recency on read.
//!   3. Insert (N - 1) NEW entries. Each evicts the oldest. After all
//!      inserts, only id_target + the (N - 1) new entries fit.
//!   4. Replay id_target — the cache MUST still contain it. Handler MUST
//!      NOT fire.
//!
//! Prints `{"handler_fired": <bool>}` to stdout. Expected value is
//! `false`. The orchestrator at
//! `tests/integration/nats-infra/cross-language-wire/orchestrator-dedup.py`
//! fails (exit 2) if any language reports `handler_fired: true`.

use lru::LruCache;
use std::num::NonZeroUsize;

// Mirrors `consumers.rs::DEDUP_CAPACITY` exactly. Hardcoded here rather
// than re-exported because the production const is private to the
// crate's consumer module — the example runs against the same `lru`
// crate the production code uses, so the recency semantics are
// identical regardless of the source of the capacity constant.
const CAPACITY: NonZeroUsize = match NonZeroUsize::new(1000) {
    Some(n) => n,
    None => panic!("CAPACITY must be non-zero"),
};

fn main() {
    let target_index = CAPACITY.get() / 2;
    let target_id = format!("id-{target_index}");

    let mut cache: LruCache<String, ()> = LruCache::new(CAPACITY);

    // Step 1: fill to capacity. `put` returns `Some(_)` on eviction; we
    // ignore the displaced value because the test models "handler fires
    // on a novel event id" via the contains/get path below.
    for i in 0..CAPACITY.get() {
        let id = format!("id-{i}");
        if cache.get(&id).is_none() {
            cache.put(id, ());
        }
    }

    // Step 2: touch the target. `get` refreshes recency.
    if cache.get(&target_id).is_none() {
        eprintln!(
            "rs:error dedup_lru: target evicted before touch — test setup bug"
        );
        std::process::exit(1);
    }

    // Step 3: insert (CAPACITY - 1) new entries. Each evicts the oldest;
    // the touched target stays alive because it's the most-recent.
    for i in 0..(CAPACITY.get() - 1) {
        let id = format!("id-new-{i}");
        if cache.get(&id).is_none() {
            cache.put(id, ());
        }
    }

    // Step 4: replay the target. A true LRU still remembers it.
    let handler_fired = cache.get(&target_id).is_none();

    // Hand-rolled JSON keeps the dep set minimal — bool printing is
    // unambiguous and the orchestrator only inspects `handler_fired`.
    println!(r#"{{"handler_fired":{handler_fired}}}"#);
}
