---
name: wake_pump rust idiom — boxed-future traits, no new deps
description: When writing tests/types for the Rust WakePump module, mirror the existing crate idiom (boxed-future return types, std::time::SystemTime) instead of pulling in async_trait or chrono — both would be new deps.
type: project
---

The Rust nats-client crate at `klodi-plugin/packages/nats-client-rs/` uses `Arc<dyn Fn(...) -> Pin<Box<dyn Future<...> + Send>>>` for its `NotificationHandler` and `ChannelHandler` aliases (see `consumers.rs:55-66`). It does NOT pull in `async_trait` or `chrono`.

When writing types or fakes for the WakePump traits (`WakePumpClient`, `ActiveSubscriptionLike`):

**Why:** The workspace's "ABSOLUTELY NO BLOAT" rule (CLAUDE.md / coding-rules.md) forbids adding deps for one-time use. The crate already has Rust 1.88 + tokio, so AFIT-style traits with boxed-future returns work without additional crates. `chrono` would add ~5 transitive crates for what `std::time::SystemTime` already does.

**How to apply:**
- For dyn-compatible async trait methods: return `Pin<Box<dyn Future<Output = T> + Send + 'a>>` directly — do NOT use `#[async_trait]`.
- For timestamps in pump health: use `Option<std::time::SystemTime>`, NOT `Option<DateTime<Utc>>`.
- The user's API spec mentioning `chrono` / `async_trait` was descriptive, not prescriptive — they explicitly said "if it isn't a dep, use the simpler pattern."

This pattern is also what the TS port does conceptually: thin wrapper, no extra runtime machinery beyond what the host platform already provides.
