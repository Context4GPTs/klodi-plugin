# Changelog

All notable changes to klodi-plugin (every adapter — `@4gpts/klodi` for OpenClaw, `klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All adapters move together — they share a single version line. Pre-1.0 the public surface is not yet stable — check this file on every upgrade before bumping the pinned version.

## [0.3.8] — 2026-07-02 — a completed wake no longer masquerades as the operator (hermes)

**All six adapters move to `0.3.8` together (lockstep version line).** The one functional change since `0.3.7` (#43) is a Hermes bugfix: on the deployed `hermes v0.17.0`, a completed wake session persists as `source='cli'` — byte-identical to a genuine operator session — so an inbound wake could crowd the real operator out of the escalation resolver's recency window. OpenClaw, `klodi-nanobot`, and the three Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) carry no functional change; they republish only to hold the shared version line.

### Fixed

- **A completed wake session no longer crowds out the genuine operator (hermes).** `hermes v0.17.0`'s one-shot `hermes chat -q … -Q` create path drops the `--source klodi` argument the bridge passes, so a finished wake turn persists with `source='cli'` — indistinguishable from a real operator's CLI session, which could push a genuine operator out of the most-recently-active window the escalation resolver reads. `_list_operator_sessions` now excludes **both** `cli` and `klodi` source classes from its `hermes_state.SessionDB.list_sessions_rich` query (`klodi` retained for forward-compat), so wake rows can no longer displace a real operator; positive `(platform, chat_id)` identification stays the load-bearing self-addressing guard. Complementing this, the bridge now records a bounded, atomic, `event_id`-keyed **wake-completion marker** at `${KLODI_HOME}/wake/completions.json` — written **only** on an inject that exits `0` (the nonzero path raises, the timeout path returns), so a downstream proof-of-turn check can never false-green on a wake that produced no turn. The now-inert `--source` behaviour and the durable resolver mechanism are recorded in [ADR-0020](./docs/decisions/0020-operator-escalation-delivery-binding.md).

## [0.3.7] — 2026-07-02 — inbound wakes actually run (hermes)

**All six adapters move to `0.3.7` together (lockstep version line).** The one functional change since `0.3.6` (#40) is a Hermes bugfix: inbound marketplace wakes never ran on the deployed pin because the bridge passed a `--session` flag no `hermes` version accepts. OpenClaw and the three Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) carry no functional change; they republish only to hold the shared version line.

### Fixed

- **Inbound wakes now actually run — the bridge no longer passes a nonexistent `--session` flag (hermes).** `BridgeCtx.inject_message` spawned `hermes chat -q <text> --session <key> -Q`, but no shipped `hermes` defines a session flag, so every wake exited 2 with `unrecognized arguments`; the bridge raised `WakeInjectFailed` and ACKed the message away — a woken agent never acted on a single marketplace event (reproduced on the deployed `v0.11.0` pin). Each wake now runs as a fresh, isolated single-turn session via `hermes chat -q <text> -Q --source klodi` (the `KLODI_WAKE_SOURCE` constant). The per-conversation key is no longer a CLI argument — it rides the spawn env (`KLODI_WAKE_ENTITY_ID`) to key the outbound pending-decision and to correlate the `wake_inject_complete` log line. **Companion change (ships together):** the operator-target resolver now excludes the wake's own session **by source** (`hermes_state.SessionDB.list_sessions_rich(exclude_sources=["klodi"])`) rather than by a `klodi:`-title guard — a fresh wake session is untitled, so without this an escalation could self-address into the bot's own transcript. Both `--source` and `exclude_sources` are confirmed present on the deployed `v0.11.0` image. The contract lives in [ADR-0019](./docs/decisions/0019-wake-inject-failure-disposition.md) and [ADR-0020](./docs/decisions/0020-operator-escalation-delivery-binding.md).

## [0.3.6] — 2026-06-30 — outbound escalation delivers for real; the skill bundle is never stale (Python adapters)

**All six adapters move to `0.3.6` together (lockstep version line).** The two changes since `0.3.5` (#37, #38) land in the Python adapters. Hermes binds the `klodi_message_user` outbound path to its own host primitives — it shipped *probe-gated* (stubbed) in `0.3.5`, so a woken agent's reach-out to its operator never actually delivered — and both Python adapters (`klodi-hermes`, `klodi-nanobot`) make the install-time skill seed unconditionally version-aware so no deploy flag can strand a stale skill on a warm volume. OpenClaw and the three Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) carry no functional change; they republish only to hold the shared version line. The two contracts are recorded in ADR-0020 (outbound delivery binding) and ADR-0021 (version-aware skill seeding).

### Fixed

- **`klodi_message_user` outbound delivery + operator resolution now bind to real Hermes primitives — no more probe-gated stubs (hermes).** The `0.3.5` outbound round-trip shipped both seams behind a runtime probe because the dev env could not confirm the host's delivery/session APIs, so `_deliver` and `resolve_operator_target` were inert stubs — a woken agent could persist a pending decision but never reach its operator. Both now bind to Hermes's own primitives, confirmed against the staging image. Delivery routes through `tools.send_message_tool._send_to_platform` over `gateway.config.load_gateway_config` — the cron-style standalone sender that works without a running gateway, deliberately **not** the in-gateway `DeliveryRouter`, which needs live adapters a `hermes-chat` wake subprocess does not hold. The operator target resolves to the most-recently-active *genuine* session via `hermes_state.SessionDB.list_sessions_rich` (ordered by numeric `last_active`, the `klodi:` wake-session family excluded by id/title namespace), with `chat_id` read from `gateway.channel_directory`. The assumed `active_sessions.json` registry and the entire `KLODI_FALLBACK_*` default-channel path are deleted — there is **no default channel**: a genuinely-absent operator surfaces a loud `no_operator_target` rather than a silent misdelivery, and the deliver-then-persist ordering is preserved. Host imports are lazy (the host modules ship only in the Hermes runtime). Host-local tool — not added to the cross-language catalog. See [ADR-0020](./docs/decisions/0020-operator-escalation-delivery-binding.md).
- **A newer bundled skill is no longer stranded on a warm volume (hermes + nanobot).** Install-time skill seeding (`seed_skill_dir`) and the Hermes runtime skill index (`install_hermes_skill_index`) treated `--no-reseed` as "never overwrite an existing target", so a redeploy onto a persisted `${KLODI_HOME}` / `${HERMES_HOME}` silently kept an older on-disk skill — `klodi` could even drop out of the agent's `<available_skills>`. Seeding is now governed solely by an on-disk-vs-bundle version compare keyed on a `.klodi-skill-version` marker stamped (last, after a successful copy) from the wheel version: a newer bundle always re-seeds; an equal-or-newer on-disk copy is a no-op (no clobber, no every-boot churn, no rollback regression); a missing/unparseable marker fails safe toward reseed. The reseed target is exactly the `skill/` tree — the user-editable siblings (`policies/`, `sell/`, `buy/`) and credentials survive by construction. The shared freshness primitives are mirrored byte-identically across both Python installers (parity-gated by `scripts/check-shared-python.sh`, whose stale Hermes path is also repaired here). See [ADR-0021](./docs/decisions/0021-version-aware-skill-seeding.md).

### Changed

- **`--no-reseed` is deprecated and inert (hermes + nanobot setup CLIs).** The flag still parses — to avoid an `unrecognized arguments` hard-fail in a transitional caller (a prod/demo `init.sh` or third-party consumer still passing it) — and emits one `klodi_no_reseed_deprecated` deprecation log line, but it can no longer suppress a version-driven upgrade. It is sequenced for removal across this repo and the klodi-stage deploy scripts; a follow-up card deletes the dead flag once the sibling image has shipped. The explicit `klodi_setup_reseed_skill` force escape hatch is unchanged (still an unconditional re-seed).



**All six adapters move to `0.3.5` together (lockstep version line).** This release hardens the wake path end-to-end and gives a woken agent a way back to its operator. Inbound wakes now survive a transport flap instead of piling up unfetched; a deterministic wake-inject/relay failure surfaces as a loud, correlated alarm in every adapter instead of being swallowed at WARNING and ACKed away; an agent can escalate a human-reserved decision to its operator and correlate the reply; and every wake runs in a per-conversation session rather than one shared, ever-growing context. Four changes land since `0.3.4` (#32–#35). The wake-failure disposition contract is recorded in ADR-0019.

### Added

- **Outbound wake round-trip — `klodi_message_user` + reply correlation (hermes).** A woken agent can now reach its operator for a human-reserved decision. The new `klodi_message_user` tool resolves the most-recently-active genuine operator session (never self-addressing; the `klodi:` wake-session family is excluded), delivers turn-less, then persists a durable, entity-keyed pending-decision pointer at `${KLODI_HOME}/pending/<entity_id>.json` — never a silent no-op. The companion `klodi_pending_decisions` tool lets the operator's next turn re-ground live marketplace state (the record is a pointer, not a snapshot) and resolve the decision exactly once. The bridge stamps the wake's per-entity id onto the spawn env (`KLODI_WAKE_ENTITY_ID` / `_TYPE` / `_EVENT_ID`) so correlation is deterministic rather than LLM-supplied, and `entity_id` is validated as a safe path component (traversal / absolute / empty refused) before any filesystem write. The persona skill gates reach-out on human-reserved decisions and scans pending decisions on every operator turn. Host-local tools — not added to the cross-language tool catalog.

### Fixed

- **Inbound wakes no longer vanish on a transport flap (hermes + nanobot).** The long-lived NATS JetStream pull subscription was bound once and reused across every reconnect, so an EOF/502 flap could leave a stale subscription whose deliver inbox never resumed — wakes piled up server-side, unfetched and silently lost. The consume loop now re-binds the pull subscription in place on a transport fetch error, backing off via the shared cross-language `BackoffPolicy` and emitting a `consumer_resubscribe` log plus a `resubscribe` metric so a never-resuming loop is visible instead of a silent wedge. The dedup LRU is preserved across re-binds, so a wake delivered-but-unacked during the blip is redelivered and de-duplicated (no double-inject); a server-side consumer deletion now surfaces as a setup error rather than an infinite silent retry.
- **Deterministic wake-inject failures surface as loud, correlated alarms (all six adapters).** A deterministic inject/relay failure was logged at WARNING — indistinguishable from a transient timeout — and the wake was ACKed away, so failures were eaten unnoticed. Each adapter now classifies the failure mode and emits a distinct ERROR alarm carrying the wake `kind` + `event_id`, while genuinely-transient failures stay WARN and redeliver: hermes raises `WakeInjectFailed` → `wake_inject_deterministic_failure` (and logs the CLI's stdout diagnostic, not just stderr); nanobot returns a typed publish outcome → `nanobot_publish_deterministic_failure`; the shared rust-http forwarder (moltis + ironclaw) ACKs a 4xx with an ERROR alarm but NAKs 5xx/transport; zeroclaw classifies `ChatError` at its post-ACK relay seam; openclaw raises enqueue failures to ERROR and spreads the `kind` / `event_id` correlator across both the enqueue-ERROR and heartbeat-WARN `wake_failed` payloads.

### Changed

- **Wakes are keyed per-conversation across every adapter.** A wake turn previously ran in one shared session — unbounded context growth and cross-conversation bleed. Each adapter now derives a per-conversation session from the event's domain — `channel.*` → `channel_id`, `listing` / `offer` / `comment.*` → `listing_id`, `transaction.*` → `transaction_id`, `search.match` → `search_slug` (multi-id events key on the conversation, never "first id present") — with a bounded `klodi:wake-<event_id>` / `klodi:wake-<uuid4>` fallback when no id is present, and a poisoned or traversal id folding into the safe fallback (THREAT_MODEL T5). Every derived session is namespaced under `klodi:` (openclaw: `agent:<id>:klodi:<entity_id>`) so the outbound resolver can tell a wake session apart from a genuine operator session. zeroclaw moves its target session off the chat-client constructor onto a per-turn send; every reply still routes back to the single operator.

## [0.3.4] — 2026-06-27 — Agent2Agent positioning across every user-facing surface

**All six adapters move to `0.3.4` together (lockstep version line).** Copy-and-positioning release — no functional, wire, or dependency changes. The one change shipped since `0.3.3` retires the "peer-to-peer agent marketplace" framing in favour of **Agent2Agent** positioning.

### Changed

- **Agent2Agent positioning replaces the peer-to-peer copy everywhere.** The product is now described as _"The Agent2Agent marketplace plugin for AI enthusiasts. Let your agent buy, sell and negotiate for you."_ — byte-identical across all eight short-description surfaces (`@4gpts/klodi` `package.json`, `openclaw.plugin.json`, hermes `plugin.yaml`, both Python `pyproject.toml` files' `description`, every adapter `README.md`, `registry/listings.yaml`, the root `README.md` / `AGENTS.md` / `SECURITY.md`, the `klodi-skill` first-run reference, and `docs/publish-readme-header.md`). The hermes manifest description — the eighth surface — was reset rather than token-swapped, clearing a "marketplace … marketplace deals" stutter. Purely user-facing copy; runtime, protocol, and tool surface are unchanged from `0.3.3`.

## [0.3.3] — 2026-06-26 — runtime analytics headers, wake-event contract repair, klodi-skill bundle namespace

**All six adapters move to `0.3.3` together (lockstep version line).** OpenClaw shipped `0.3.2`; the other five (`klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) were bumped to `0.3.2` in their manifests but never published, so `0.3.3` is their first release since `0.3.1`. Three changes land since `0.3.2`.

### Added

- **OpenClaw RPCs now carry runtime + install-source headers.** Every outbound OpenClaw RPC stamps `X-Klodi-Runtime: openclaw` and `X-Klodi-Plugin-Source` (`clawhub` / `npm` / `unknown`, read from `KLODI_PLUGIN_SOURCE`) via a constructor-injected static header map on the shared `nats-client-ts`. This lets the marketplace populate a non-null `plugin_source` on `user_registration_events` for the install→registration funnel; it is also logged in `klodi_plugin_loaded`. The shared client stamps whatever keys it is handed — the `openclaw` literal and the plugin-source concept stay in the adapter, inert without injection.

### Fixed

- **Python wake-event model + cross-language contract tests realigned to the canonical golden corpus.** The shared corpus and the Rust shapes had migrated weeks earlier while the Python `klodi_nats_client` model and the TS/Python contract suites still asserted the dead schema. `search.match` now carries a `fulfillment` array of method-tagged `DeliveryOffer`s (`pickup` / `ship` / `digital`) instead of the flat `delivery_method` / `location_area` pair; `channel.message` no longer carries an in-body `sequence` (JetStream injects it post-parse). Recorded as ADR-0017. **Out-of-tree Python consumers of `klodi_nats_client`** (the vendored client inside `klodi-hermes` / `klodi-nanobot`) must move to the `fulfillment` union — re-vendor to pick up the new `events.py`.

### Changed

- **The canonical build-time skill bundle is namespaced `klodi-skill/`.** The source dir `klodi-plugin/skill/` is renamed to `klodi-plugin/klodi-skill/`, and every adapter build-input consumer moves with it (OpenClaw `copy-skill.mjs` / `vendor.mjs`, hermes/nanobot `copy-skill.py`, moltis/ironclaw `vendor.py`, `registry/listings.yaml`). The OpenClaw plugin now publishes its skill under the namespaced `klodi-skill` slug so it cannot collide with other hosts shipping a generic `skill/` folder. The install-time `${klodi_home}/skill` per-user state path is deliberately unchanged (renaming user state would break upgrades); zeroclaw ships no embedded skill and is untouched. Recorded as ADR-0018.

## [0.3.2] — 2026-06-24 — reconcile openclaw package↔manifest version drift

**All adapters.** Packaging-metadata patch bump in lockstep — no functional or wire changes. The OpenClaw plugin registry flagged `klodi` as `package-manifest-version-drift` and disabled the target: the published `0.3.1` declared `package.json` version `0.3.1` but an `openclaw.plugin.json` manifest version of `0.3.0`. The two diverged because `scripts/stamp-version.mjs` rewrote only the manifest's pinned-tag GitHub URLs at publish time, never the manifest's own top-level `version` field — so the `0.3.0 → 0.3.1` bump left the manifest behind.

### Fixed

- **The OpenClaw manifest version now tracks `package.json`.** `stamp-version.mjs` additionally stamps the top-level `version` field in `openclaw.plugin.json` from `package.json#version` (the single source of version truth) at `prepublish`. A new static guard — `manifest-version-symmetry.test.ts` — fails `pnpm -C adapters/openclaw test` if the manifest version ever drifts from `package.json` again, catching it before publish instead of at the registry.

### Changed

- All six adapters (`@4gpts/klodi`, `klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) move to `0.3.2` together (lockstep version line). npm `@4gpts/klodi@0.3.1` is immutable, so the corrected manifest ships as `0.3.2`; bumping every adapter keeps the shared version line aligned and lets the OpenClaw target be re-enabled.

## [0.3.1] — 2026-06-18 — remove listing expiry from the wire contract

**All adapters.** Listing expiry leaves the wire. The marketplace no longer accepts or emits a listing TTL (epic `remove-listing-expiry-2026-06`, keystone `4gpts-p2p-marketplace`), so the plugin's listing tools drop it in lockstep: the `expires_hours` request parameter is gone from `klodi_list_create` and `klodi_list_update`, and the `expires_at` reply field is gone from `ListingResult` — the shape shared by all six listing replies (`klodi_list_create`, `_update`, `_get`, `_mine`, `_withdraw`, `_relist`). This is a breaking wire change for any agent that sent `expires_hours` or read `expires_at` on a listing.

Channel TTLs are untouched: `klodi_channel_create` and `klodi_channel_mine` still carry their own `expires_at` (a channel field, unrelated to listing expiry).

### Removed

- `expires_hours` request parameter on `klodi_list_create` and `klodi_list_update`. Passing it is now an unknown field — never forwarded to the marketplace.
- `expires_at` reply field on every listing reply (`ListingResult`). The key is **removed, not nulled** — a listing reply no longer has an `expires_at` property at all (not `expires_at: null`). Agents that previously null-checked `listing.expires_at` now read `undefined`.
- The `expires_hours` / TTL sentence from the `klodi_list_update` agent-facing tool description.

### Migration

**Agents.** Stop sending `expires_hours` on `klodi_list_create` / `klodi_list_update`; stop reading `expires_at` off any listing reply (it is absent, not null). Restart any long-running agent session after upgrade so the host re-fetches the tool catalog and stops offering `expires_hours`.

**Lockstep with the marketplace.** This is a coordinated breaking wire change — it must ship together with the marketplace's removal of listing expiry (epic `remove-listing-expiry-2026-06`, keystone `4gpts-p2p-marketplace`). The plugin side is internally safe with the field simply absent, but shipping the plugin ahead of the marketplace means agents stop sending a TTL the marketplace may still default-impose; shipping it behind means the plugin reads an `expires_at` the marketplace no longer emits. All six adapters move together to `0.3.1` (a patch bump — the default for this repo). Pre-1.0 the version is a lockstep coordination marker, not a semver break signal: pin the exact version and read this changelog before upgrading (see the note at the top of this file).

**Out-of-tree consumers of `klodi_nats_client` (Python) / the vendored `schemas.json` (Rust).** The regenerated `schemas.json` no longer declares listing `expires_at` / `expires_hours` in any `klodi_list_*` block. Re-vendor to pick up the new schema.

## [0.3.0] — 2026-06-03 — cross-adapter request/response parity + standing-search feedback flywheel

**All adapters.** The standalone `klodi_assets_upload_url` tool is removed. `klodi_list_create` and `klodi_list_update` now accept image URLs *or* absolute local file paths in `photos` — local paths are content-sniffed, uploaded to R2 by the adapter, and substituted with the durable `asset_url` before the listing is dispatched. One tool call replaces the previous mint-PUT-attach dance. Allowlist (`image/jpeg`, `image/png`, `image/webp`), per-file 10 MB ceiling, and per-listing 10-photo cap are unchanged (ADR-0006); enforcement moves into the listing tool. All-or-nothing: any rejected path fails the entire call with a structured error naming the offending path.

### Removed

- `klodi_assets_upload_url` tool and the `p2p.v1.assets.upload-url` agent-facing subject. The subject is still used internally by adapters; only the agent-facing tool is gone.
- The two-step "mint URL → PUT bytes → attach `asset_url`" flow from `skill/references/photo_upload_flow.md` (now `skill/references/photos.md`) and the Assets section of `skill/references/tool_inventory.md`.

### Migration

**Agents:** none — the skill teaches the new one-call flow. Restart any long-running agent session after upgrade so the host re-fetches the tool catalog and stops seeing `klodi_assets_upload_url` in its cache.

**External integrators scripting against `klodi_assets_upload_url` directly:** none known (see `registry/listings.yaml` — no third-party tool references this subject). If you are one, switch to passing local paths or URLs straight into `klodi_list_create` / `klodi_list_update`; the adapter does the mint and PUT for you. Open an issue if you need the raw mint endpoint exposed as a host-side primitive.

### Adapter exception envelope and pre-call guard parity (all adapters)

**Every adapter** (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw) now surfaces the same structured error envelope `{error, message, details, recovery_hint}` for every failure path, drawn from a single closed error-code vocabulary at `packages/tool-catalog/src/error-codes.ts`. The three pre-call guards (`creds_present` → `connection_ready` → `args_well_formed`) run before any I/O in every language stack. Long-running agent sessions need a restart — the openclaw flat-string `{content, isError}` shape, the hermes/nanobot partial-JSON shape, and the Rust `McpError::invalid_params` leak path are all replaced by the canonical envelope. See [ADR-0011](./docs/decisions/0011-adapter-exception-envelope.md).

### Added

- **Catalog (`@klodi/tool-catalog`):** `errorCodes` map (13 codes) — the cross-language canonical vocabulary. `RecoveryKind` discriminator type. Codegen step at `packages/tool-catalog/src/codegen/error-codes.ts` emitting `dist/error-codes.json`; mirrored to `packages/nats-client-py/src/klodi_nats_client/error_codes.json`. Cross-language drift gate at `packages/tool-catalog/tests/error-codes-cross-language.test.ts` (4 tests) — scans Rust + Python envelope sources for code literals and asserts every emitted code is in the TS catalog.
- **`klodi-rust-host` (internal, shipped vendored in moltis / ironclaw / zeroclaw crates):** `mcp::envelope` module (`ToolEnvelope`, `envelope_from_klodi_err`, `envelope_from_klodi_err_with_cli`, `envelope_to_call_tool_result`, `invalid_request_envelope`, `internal_error_envelope`, `not_registered_envelope_json`). `mcp::guards` module (`guard_creds`, `guard_args`, `run_pre_call_guards`, `ArgKind` enum). `McpConfig.register_cli` field — mandatory per-host CLI name substituted into `not_registered` recovery hints (R8).
- **`klodi-hermes` + `klodi-nanobot` (Python):** `klodi_nats_client.envelope` module (`make_envelope`, `envelope_from_klodi_request_error`, `envelope_from_invalid_request`, `envelope_from_not_connected`, `envelope_from_unknown`). `klodi_nats_client.guards` module (`guard_creds`, `guard_args`, `run_pre_call_guards`, `ArgKind`). `HERMES_REGISTER_CLI` / `NANOBOT_REGISTER_CLI` constants.
- **`@4gpts/klodi` (openclaw):** `lib/envelope.ts` (`ToolEnvelope`, `makeEnvelope`, `envelopeFromError`, `envelopeToToolResult`). `lib/guards.ts` (`guardCreds`, `guardArgs`, `runPreCallGuards`, `runPreCallGuardsResult`, `connectionNotReadyEnvelope`, `notRegisteredEnvelope`).
- **Bundled skill:** `skill/references/error_envelopes.md` — agent-facing documentation of the envelope shape and recovery-hint vocabulary. Cross-link audit at `packages/tool-catalog/tests/skill-coverage.test.ts` asserts every code in the catalog appears in the doc and every code in the doc exists in the catalog.
- **E2E coverage:** `packages/klodi-rust-host/tests/e2e_envelope.rs` (4 tests) + `adapters/zeroclaw/tests/mcp_envelope_e2e.rs` (2 tests) — spawn the compiled `klodi-zeroclaw-mcp` binary with an empty `KLODI_HOME` and assert the canonical four-key envelope on stderr.

### Removed

- **openclaw:** `lib/tool-result.ts::formatError`, `errorResult`, `requireCreds`, `requireCredsEnvelope` — all deleted (CLAUDE.md "no backwards compatibility"). The flat-string `{content: [{type:"text", text:"<message>"}], isError: true}` return path is gone. Tools call `runPreCallGuardsResult` from `lib/guards.js` instead.
- **`klodi-rust-host`:** `mcp::tools::map_klodi_err` — replaced by `envelope_for` → `envelope_from_klodi_err_with_cli`.
- **hermes / nanobot:** the `except BaseException → envelope_from_not_connected()` catch-all that mislabelled every non-Klodi exception as `connection_not_ready` — replaced by the split `except _CONNECTION_ERROR_TYPES → connection_not_ready` / `except BaseException → internal_error` arms.

### Migration

**All adapters.** Long-running agent sessions need a restart. Agents that pattern-match on the pre-card flat-string responses break on the first failure response. The agent's recovery prompt should be updated to read the structured envelope per `skill/references/error_envelopes.md` (bundled).

**Out-of-tree consumers of `klodi_nats_client` (Python).** `envelope.py` and `guards.py` are new modules. Existing `KlodiRequestError` callers continue to work; the envelope helpers are additive. The `error_codes.json` vendored alongside is the catalog's authoritative code list.

**Out-of-tree consumers of `klodi_rust_host`.** Internal crate (`publish = false`); the surface change lands in moltis / ironclaw / zeroclaw via vendoring. Public re-exports add `ToolEnvelope`, `envelope_from_klodi_err`, `envelope_from_klodi_err_with_cli`, `envelope_to_call_tool_result`, `invalid_request_envelope`, `internal_error_envelope`, `not_registered_envelope_json`, `McpConfig.register_cli` (mandatory field).

### Standing-search match feedback — `klodi_match_feedback` (SC8 flywheel)

**In-agent adapters (openclaw, hermes, nanobot).** New publish tool `klodi_match_feedback`: when an agent pursues or dismisses a listing a standing search surfaced, it emits `{ search_slug, listing_id, outcome: "pursued" | "dismissed", action_on_match? }` on `p2p.v1.searches.match_feedback` — the emit half of the marketplace's self-improving search flywheel (SC8). The body carries the *action* (`outcome`), never a ± training label; the marketplace derives the label server-side. `search_slug` / `listing_id` ride in the body as bounded strings, matching the marketplace `MatchFeedback` contract field-for-field — deliberately **not** the strict UUID guard, since a non-UUID `listing_id` the service accepts must be accepted here. Daemon-shaped adapters (moltis, ironclaw, zeroclaw) ship the wire helper for parity but do not register the tool — it is `in_agent`-only.

### Added

- `klodi_match_feedback` catalog entry (`kind: publish`, `host_shapes: [in_agent]`) with a frozen schema (`outcome ∈ {pursued, dismissed}`, `additionalProperties: false`).
- Wire helpers across every nats-client stack — `publishMatchFeedback` (TS), `publish_match_feedback` (Python), `validate_match_feedback` + `MatchFeedbackPayload` (Rust) — serializing byte-identically (same field order, `action_on_match` omitted not null when absent, a fresh `event_id` per emit as the `Nats-Msg-Id` dedup header).
- Registrations in openclaw (`discovery.ts`), hermes (`tools.py`), nanobot (`nanobot_tools.py`).

### Migration

None — additive. Restart long-running agent sessions so the host re-fetches the catalog and exposes `klodi_match_feedback`.

### Search request-payload parity (ADR-0012)

**All adapters.** `klodi_search` and `klodi_searches_create` now forward the raw catalog-shaped payload to the marketplace unchanged. Previously openclaw ran `compactPayload`, dropping `undefined` / `null` / `""` fields — so `klodi_search({ query: "", category: null })` reached the service as `{}` on openclaw but as `{ query: "", category: null }` on every other stack, diverging on exactly the edge the upgraded semantic / multilingual ranker is most sensitive to. `compactPayload` now lives **only** inside the `klodi_watch` composite, where the stripped fields (`persist`, `action_on_match`, `target_price`) are genuinely adapter-internal. openclaw also exposes `klodi_searches_create` as a first-class catalog tool (previously reachable only through `klodi_watch`), matching every other stack. A golden wire-payload fixture (`search-payload-golden.json`) + per-stack parity tests gate the invariant. See [ADR-0012](./docs/decisions/0012-tool-request-payload-parity.md).

### Changed

- **openclaw:** `klodi_search` / `klodi_searches_create` no longer compact the payload — empty-string, `null`, and omitted are three distinct inputs forwarded as the agent issued them; the marketplace is the sole interpreter.
- **openclaw:** `klodi_searches_create` is now a standalone catalog tool (one entry point per NATS subject).

### Migration

None for agents issuing well-formed search params. openclaw agents that relied on empty / `null` search fields being silently dropped will now have those fields forwarded to the marketplace. Restart long-running agent sessions to refresh the catalog.

### Internal / tooling

- openclaw's plugin-load smoke fixture is now model-agnostic (no hardcoded model id); a cross-adapter sweep asserts no `adapters/*/scripts/smoke*.sh` pins a model literal.
- `cards/` is no longer tracked (gitignored single-device kanban); ADR-0012 landed under `docs/decisions/`.

## [0.2.16] — 2026-05-14 — klodi-zeroclaw Telegram bridge (supersedes wake-agent-spawn)

**klodi-zeroclaw only.** zeroclaw 0.7.4 silently no-ops `sessions_send` from a concurrent operator dashboard tab and removed `/api/agent/spawn` and `/api/cron/{id}/run`. The 0.2.13 wake-agent-spawn architecture cannot be delivered as designed against shipped zeroclaw. This release pivots to Telegram as the operator surface — zeroclaw becomes the agent runtime only, never the operator UX.

Wire-shape changes are breaking despite the patch-level bump — see Migration.

### The architecture, in one sentence

NATS event → daemon → `OperatorSessionController` inbox → single-flight `/ws/chat` turn against one persistent zeroclaw session per operator → agent's `done.full_response` shipped verbatim to Telegram via `sendMessage`. Inbound Telegram messages from the operator fan into the same inbox.

### What this delivers

- **Operator visibility is the LLM's job.** Same as 0.2.13 — but the delivery primitive moves from `sessions_send` (broken on shipped zeroclaw) to Telegram `sendMessage` driven by the daemon. The agent's closing sentence IS the notification.
- **One zeroclaw session per operator, resumed on every wake.** `sessions_history` works for in-session continuity → the agent has memory across turns. Failure recovery: daemon restart re-resumes via `/ws/chat?session_id=<X>`; the gateway's `session_start` returns `resumed:true, message_count:N`.
- **NATS ack < 50ms regardless of agent-turn duration.** ACK happens at *dispatch* time — when the event lands in the controller's mpsc inbox, not when the LLM finishes. Operator bursts beyond inbox capacity (64) NAK the JetStream message for redelivery.
- **Single-flight per session.** A `tokio::sync::Mutex` in `ChatClient` serialises concurrent `send_and_wait` calls so the gateway never sees two in-flight turns on the same session_id.
- **Telegram poll offset survives crashes.** `${KLODI_HOME}/telegram.offset.json` is written atomically after every successful dispatch; on restart the daemon resumes from `last_acked_update_id + 1`. Worst case: one update gets redelivered after a crash mid-write.

### Removed in 0.2.16

- `klodi_rust_host::zeroclaw_spawn::{SpawnClient, SpawnError, SpawnOutcome, SpawnPath}` and the underlying `NativeSpawnBody` / `CronCreateBody` / `CronRunResponse` / `CronDelivery` types. The `zeroclaw_spawn.rs` module is deleted in full (~430 LOC).
- `klodi-zeroclaw-daemon --force-cron-fallback` flag + `ZEROCLAW_FORCE_CRON_FALLBACK` env var — there is no cron fallback path to force.
- `klodi-zeroclaw-daemon --zeroclaw-token` flag + `ZEROCLAW_AGENT_TOKEN` env override — the daemon reads `${KLODI_HOME}/zeroclaw.token` exclusively now (operators wanting to move tokens around re-run `klodi-zeroclaw-register`).
- `sessions_send` and `sessions_history` from the canonical wake prompt — neither path reaches the operator's Telegram chat.
- The `operator_session_id` field on `WakePromptInputs` — replaced with `chat_id`.

### Added in 0.2.16

- `klodi_rust_host::zeroclaw_chat::{ChatClient, TurnOutcome, ChatError}` — single-flight WS chat client. One turn per event, 600s ceiling, drops `chunk` buffers on `chunk_reset`, returns the agent's `done.full_response`.
- `klodi_rust_host::telegram::{TelegramClient, TelegramError, TelegramBot, TelegramUpdate, TelegramMessage}` — thin Telegram Bot API client: `get_me` for token validation, `send` with 4096-char newline splitting + 429 retry-honouring + 5xx exponential backoff, `poll_updates` for inbound long-poll.
- `klodi_rust_host::operator_session::{OperatorSessionController, OperatorInbox, InboundEvent, DispatchError}` — per-operator coordinator. NATS and Telegram fan into one mpsc inbox (capacity 64); the worker task drains serially, one zeroclaw turn per event, forwarding replies to Telegram.
- `klodi_rust_host::telegram_config::{TelegramConfig, TelegramOffset, TelegramLastSend}` + read/write helpers — atomic persistence of `${KLODI_HOME}/telegram.json` (mode 0600), `${KLODI_HOME}/telegram.offset.json` (mode 0644, debug-readable), `${KLODI_HOME}/telegram.last-send.json` sidecar.
- `klodi-zeroclaw-register` Telegram onboarding flow — validates the bot token via `getMe`, picks chat_id by polling `getUpdates` for the operator's `/start`, writes `telegram.json`, sends a hello line. New flags: `--bot-token <TOKEN>` / `TELEGRAM_BOT_TOKEN` (scripted setup), `--chat-id <N>` / `TELEGRAM_CHAT_ID` (non-interactive chat selection), `--re-pair-telegram` (rotate the bot), `--skip-telegram` (headless CI).
- `klodi-zeroclaw-daemon --telegram-config <path>` / `TELEGRAM_CONFIG` — override the default `${KLODI_HOME}/telegram.json` location. Tests-only; production reads the default.
- `klodi_setup_status` JSON gains `telegram_config_present`, `telegram_bot_username`, `telegram_chat_id`, `telegram_last_send_ts`. `klodi-zeroclaw-setup-status` requires `telegram.json` for `phase: "ready"`; missing surfaces `next_action: { kind: "cli", command: "klodi-zeroclaw-register" }` with a `telegram_unpaired` issue code. Other adapters' setup-status binaries keep their existing phase machine via the new opt-in `SetupStatusOptions { require_telegram: false }`.
- `SetupStatusOptions` + `klodi_setup_status_with_options(klodi_home, options)` — the legacy `klodi_setup_status_with_register_cli` continues to work and defaults to `require_telegram: false`.
- `klodi-zeroclaw 0.2.16` version bump (other adapters stay on 0.2.12). The internal `klodi-rust-host` crate stays on 0.2.0 — surface added, none removed from the public re-exports beyond the dropped `SpawnClient`.

### Migration

**klodi-zeroclaw operators.** Stop the 0.2.15 daemon. Talk to `@BotFather` on Telegram to create a fresh bot, copy the token, then run `klodi-zeroclaw-register --re-pair-telegram` (or the first-time `klodi-zeroclaw-register` if upgrading from before this series). The interactive prompt asks for the bot token, validates it, then asks you to send `/start` to your new bot and confirms the chat_id. Persists `${KLODI_HOME}/telegram.json` (mode 0600). The daemon now fails to start without `telegram.json` — pass `--skip-telegram` on register only for headless CI hosts that genuinely have no operator surface.

Existing `${KLODI_HOME}/{nats.creds,config.json,zeroclaw.token,zeroclaw.session}` are preserved. The persistent operator session resumes via `WS /ws/chat?session_id=<existing>`; `sessions_history` carries forward.

**Operator-side env changes.** `ZEROCLAW_AGENT_TOKEN` and `ZEROCLAW_FORCE_CRON_FALLBACK` are gone. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CONFIG` are added. `KLODI_HOME`, `KLODI_CREDS`, `KLODI_CONFIG`, `ZEROCLAW_HTTP_BASE`, `ZEROCLAW_HEALTH_PORT`, `KLODI_API_URL`, `ZEROCLAW_CONFIG`, `ZEROCLAW_CLI` continue to work as before.

**Other adapters.** No migration. Moltis/IronClaw daemons still POST structured envelopes to their local wake URLs. `klodi_setup_status_with_register_cli` keeps the previous behaviour; only the new `klodi_setup_status_with_options` with `require_telegram: true` blocks `Ready` on `telegram.json`.

**Out-of-tree consumers of `klodi_rust_host`.** The crate is internal-only (`publish = false`), so this surface change does not affect crates.io consumers. The vendored copy inside the `klodi-zeroclaw` .crate ships the new modules.

## [0.2.15] — 2026-05-13 — klodi-zeroclaw cron-fallback `schedule` is a bare string

**klodi-zeroclaw only.** Every NATS wake against gateways that ship `/api/cron` but not `/api/agent/spawn` was 422-ing because the cron-fallback `POST /api/cron` body serialised `schedule` as `{ "at": "now" }` — upstream zeroclaw expects a bare `"now"` string. The demo (`demo/zeroclaw-live.Dockerfile` tier) froze on the first `channel.opened` / `channel.message` / `offer.proposed` wake; the daemon couldn't get a single agent turn off the ground. Pure runtime fix — no surface change.

### Fixed (`klodi-zeroclaw` 0.2.15)

- **`CronCreateBody.schedule` is `&'static str = "now"`** in `packages/klodi-rust-host/src/zeroclaw_spawn.rs`. The `CronSchedule { at: "now" }` wrapper struct was deleted; `create_cron` now constructs the body with `schedule: "now"` directly. Symptom on 0.2.13 / 0.2.14: `spawn returned non-2xx: 422 Unprocessable Entity Failed to deserialize the JSON body into the target type: schedule: invalid type: map, expected a string at line 1 column 12`, repeated on every wake. Native `/api/agent/spawn` was never affected — only the cron fallback path hit this.
- **Regression coverage.** `falls_back_to_cron_on_404` now asserts the `POST /api/cron` body via `wiremock::matchers::body_partial_json` (`schedule: "now"`, `agent: true`, `session_target: "isolated"`, `delete_after_run: true`). A future refactor back to a wrapper struct fails the test instead of silently shipping.

### Migration

None. Update `klodi-zeroclaw` from 0.2.14 → 0.2.15 (e.g. rebuild `demo/zeroclaw-live.Dockerfile` to pick up the new `max_stable_version`). No config, env, or wire-shape changes for operators.

## [0.2.14] — 2026-05-13 — klodi-zeroclaw register is idempotent + `--force-register` repair primitive

**klodi-zeroclaw only.** Two paired changes. The shipping fix: `klodi-zeroclaw-register` no longer opens browser OAuth on every container restart when `${KLODI_HOME}/{nats.creds,config.json}` are already on disk — making the demo-container boot loop survivable and the human first-run flow idempotent. The paired addition: a new `--force-register` CLI flag on every Rust adapter's register binary, surfacing the repair primitive that Hermes's `klodi_setup_repair` MCP tool provides for Python adapters but that Rust hosts deliberately cannot expose on the agent's MCP surface.

### Fixed (`klodi-zeroclaw` 0.2.14)

- **`klodi_rust_host::register::run_register` short-circuits when valid creds already exist.** If `${KLODI_HOME}/nats.creds` is non-empty AND `${KLODI_HOME}/config.json` parses with `handle` + `user_id` populated, the function prints a one-line "Reusing existing klodi credentials at <home> (handle @<handle>)" notice and returns `Ok(())` without minting a session UUID, printing the `authorize?session=…` URL, or polling. The downstream pair + session-bootstrap steps in `klodi-zeroclaw-register` run unchanged (they already had their own cached-bearer fast paths via `${KLODI_HOME}/zeroclaw.token` and `${KLODI_HOME}/zeroclaw.session`), so the full restart flow is now idempotent end-to-end.
- The same fix lands automatically for `klodi-moltis-register` and `klodi-ironclaw-register` since they share `run_register`, but those adapters did not exhibit the boot-loop symptom (they don't write `zeroclaw.token` / `zeroclaw.session`), so no version bump for them.

### Added (`klodi-zeroclaw` 0.2.14)

- **`--force-register` flag on `klodi-zeroclaw-register` (also wired into `klodi-moltis-register` and `klodi-ironclaw-register` for parity).** Bypasses the short-circuit and runs a fresh OAuth flow even when creds already exist on disk — the operator-side equivalent of Hermes's `klodi_setup_repair` MCP tool. The flag is set on the CLI rather than the MCP catalog because the Rust wake agent's `klodi-*-mcp` server is itself running on top of `${KLODI_HOME}/nats.creds` (cf. the `assert!(!names.contains(&"klodi_setup_repair"))` invariant at `packages/klodi-rust-host/src/mcp/tools.rs:521`, comment "Register-only tools never appear on the agent's MCP surface") — an in-agent repair tool would saw off the branch the agent is sitting on mid-call. Operator-driven CLI repair sidesteps the constraint.
- A failed `--force-register` attempt (e.g. OAuth session expired before the operator clicked through) leaves the pre-existing `${KLODI_HOME}/{nats.creds,config.json}` untouched — `persist_session` only writes on the completed-session branch, so transient failures during repair do not strand the operator without an identity.

### Repair workflows

- **Rust adapters (zeroclaw / moltis / ironclaw):** `klodi-zeroclaw-register --force-register` (or the matching `klodi-moltis-register --force-register` / `klodi-ironclaw-register --force-register`). Equivalent manual flow: `rm ${KLODI_HOME}/{nats.creds,config.json}` and re-run `klodi-zeroclaw-register` with no flags.
- **OpenClaw (Python via Hermes):** `klodi_setup_repair` MCP tool — unchanged.

### Migration

None. Existing `${KLODI_HOME}` layouts work as-is; subsequent `klodi-zeroclaw-register` invocations now no-op the OAuth step instead of churning a fresh `sessions` row on the marketplace. Operators rotating accounts or recovering from a bad `config.json` use `--force-register`.

## [0.2.13] — 2026-05-12 — klodi-zeroclaw clean break

**klodi-zeroclaw only — every other adapter is untouched.** This release rebuilds the zeroclaw adapter against a new wake-agent-spawn architecture. It entirely supersedes the 0.2.6 → 0.2.12 wake-routing + operator-visibility series. Wire-shape changes are breaking despite the patch-level bump — see Migration.

### The architecture, in one sentence

NATS event → daemon → `POST /api/agent/spawn` with the event as the prompt → ZeroClaw runs the LLM in an isolated session → LLM acts via `klodi_*` and writes to the operator's chat via `sessions_send` only when the operator should see something.

When a gateway hasn't yet shipped `/api/agent/spawn`, the spawn client transparently falls back to `POST /api/cron` (one-shot, isolated, delete-after-run) + `POST /api/cron/{id}/run`. The path-selection probe runs once per daemon process and is auto-detected from the gateway's response — operators can also force the cron path with `ZEROCLAW_FORCE_CRON_FALLBACK=1`.

### What this delivers

- **Operator visibility is the LLM's job.** Routine activity is silent. When the LLM decides the operator should see something it writes one line in its own voice via `sessions_send`. No firehose, no `[INFO]` lines, no plugin-namespaced infrastructure messages.
- **NATS ack < 50ms, regardless of agent-turn duration.** The daemon's "did the wake land?" question becomes "did the spawn POST return 200?" Wake delivery decouples completely from how long the LLM takes to reason.
- **Approval happens in chat naturally.** The operator types "yes" or "no"; the next wake on that listing reads the reply via `sessions_history`. No plugin-side approval state machine.

### Removed in 0.2.13

- `klodi_report_to_operator` / `klodi_escalate_to_user` MCP tools — `sessions_send` is the primitive; the LLM curates directly.
- Severity enum (`diagnostic | operator | operator_important | approval_request`) — the LLM phrases each situation in its own register.
- Per-wake-kind formatting matrix in the daemon — the LLM phrases each event type.
- Approval-gate state machine in `mcp/tools.rs` — replies happen in chat.
- Channel registry / `OperatorChannel` trait / `DashboardChannel` / `UpstreamChannel` / `DedicatedSessionChannel` / `ChannelInvoker` / `CreatedSessionsLedger` / `DispatcherCursor` — every notification path now flows through the spawned agent.
- Klodi inbox self-hosted SPA (`packages/klodi-rust-host/src/inbox/`, `assets/inbox.html`, the `/inbox/*` HTTP routes) — there is no longer an escalation surface to render.
- Pairing shim / loopback HTTP listener (`zeroclaw_pairing_shim`) — register pairs directly during the one-time setup.
- Plugin-authored bootstrap/heartbeat note (`zeroclaw_bootstrap_note`) — register writes one hello line and exits.
- WS-based wake delivery (`BodyShape::ZeroClawRegistry`, the WS forwarder loop) — wakes use HTTP spawn.
- Embedded skill bundle (`skill_bundle`, `klodi://skill/*` MCP resources, the `skill/` directory) — the wake prompt is the catalog.
- Klodi-side policy seeding (`policy_seed`, `klodi_setup_reseed_policies`, `policies/{negotiation_style,security}.md` templates) — operators author `${KLODI_HOME}/negotiation_style.md` themselves; the wake prompt points the agent at it.
- Reply-attribution task in the daemon — there's no approval gate to feed.
- `BodyShape::ZeroClawRegistry` from `klodi_rust_host::forwarder` — the forwarder is now a callback-driven shell; the structured-HTTP variant lives in `forwarder::HttpStructuredHandler` for Moltis/IronClaw, and zeroclaw supplies its own `SpawnWakeHandler`.
- `klodi_rust_host` features renamed `zeroclaw_session` → `zeroclaw` and trimmed (no more `tokio-tungstenite` in the daemon path; only `register` keeps a WS client for the one-shot session bootstrap).
- `setup_status` phase `NeedsPolicy` and the `negotiation_style_*` / `security_policy_*` fields — the plugin no longer audits policy files.

### Added in 0.2.13

- `klodi-zeroclaw-register` mints the ZeroClaw bearer + bootstraps the operator chat session as part of the one-time setup flow. Persists `${KLODI_HOME}/zeroclaw.token` (mode 0600) and `${KLODI_HOME}/zeroclaw.session` (mode 0600).
- `klodi-zeroclaw-daemon` becomes a thin driver: subscribe NATS → compose the canonical wake prompt → `SpawnClient::spawn(prompt)`. ~200 lines including CLI parsing.
- `klodi_rust_host::wake_prompt::build_wake_prompt` — pure, tested builder for the canonical wake-prompt template.
- `klodi_rust_host::zeroclaw_spawn::SpawnClient` — auto-detects `/api/agent/spawn` vs cron fallback, wiremock-tested for both paths.
- `klodi_rust_host::forwarder::{WakeEvent, WakeHandler, HttpStructuredHandler}` — generic callback-driven forwarder; Moltis/IronClaw keep their HTTP shape via `HttpStructuredHandler`, zeroclaw supplies its own.
- `klodi-zeroclaw 0.2.13` version bump (other adapters stay on 0.2.12). The internal `klodi-rust-host` crate (`publish = false`, vendored at `make build`) jumps to `0.2.0` to mark the API reshape — vendored, not published.

### Migration

**klodi-zeroclaw operators.** Stop the 0.2.x daemon. Run `klodi-zeroclaw-register` once to pair + bootstrap the new operator session, then start `klodi-zeroclaw-daemon` (no required flags — defaults to `http://127.0.0.1:7070`). The old `${KLODI_HOME}/zeroclaw.session` is reused if present; `${KLODI_HOME}/policies/`, `${KLODI_HOME}/buy/`, `${KLODI_HOME}/sell/` are untouched. The `ZEROCLAW_WEBHOOK_URL` env var is gone — use `ZEROCLAW_HTTP_BASE` (no `/webhook` suffix). The `--adopt-session`, `--browser-pair-shim-port`, `--open-browser`, `--zeroclaw-cli` flags are gone — pairing happens in register, the helper shim no longer exists.

**Other adapters.** No migration. Moltis/IronClaw daemons still POST structured envelopes to their local wake URLs and ack on receipt; their daemon binaries now import `forwarder::HttpStructuredHandler` instead of the old `BodyShape::Structured` enum. The wire shape is unchanged.

**Out-of-tree consumers of `klodi_rust_host`.** The crate is internal-only (`publish = false`), so this surface change does not affect crates.io consumers. In-tree adapters above are migrated.

## [0.2.12] — 2026-05-12

Two slices in this release. **Every adapter republishes** for the schema change; **klodi-zeroclaw** additionally ships the operator-visibility surface for `klodi_escalate_to_user`.

**Universal — `klodi_list_*` schema.** Listings can now have no expiry. `expires_at` becomes nullable on every reply that carries a listing (klodi_list_create, _update, _get, _mine, _withdraw, _relist), and `klodi_list_update` gains an `expires_hours` parameter that lets the agent set a fresh TTL from now or pass `null` to clear the expiry entirely. Wire-level change — agent code that dereferences `expires_at` without a null check breaks.

**klodi-zeroclaw — Klodi inbox surface.** On 0.2.11 the `DashboardChannel::notify` write into `/ws/chat` was the only way `klodi_escalate_to_user` reached an operator looking at a dashboard tab. Empirical investigation showed that path never actually delivers the frame to the operator's already-open browser tab (the gateway's `/ws/chat` is request-scoped, not a broadcast bus), and every write fired a wasted server-side agent loop in the operator's session. 0.2.12 retires that write and ships the **klodi inbox** instead: a loopback-served SPA mounted on the existing pairing-shim listener that polls the dedicated session's REST history for open escalations, renders them to the operator, and threads replies back via `zeroclaw_ws::send_session_message`.

### Added (every adapter — `klodi_list_*` schema)

- **`expires_at` is nullable on every listing reply.** Affected tools: `klodi_list_create`, `klodi_list_update`, `klodi_list_get`, `klodi_list_mine` (each element of `listings[]`), `klodi_list_withdraw`, `klodi_list_relist`. JSON Schema becomes `{"anyOf": [{"description": "ISO 8601 timestamp", "type": "string"}, {"type": "null"}]}`; the field remains `required`, only its value type widens.
- **`klodi_list_update` accepts `expires_hours`.** Optional nullable integer (`minimum: 1`). A positive integer sets a fresh TTL from the time the update lands; `null` clears the expiry on a listing that previously had one. Omitting the field leaves the existing expiry untouched.

### Changed (every adapter — `klodi_list_*` schema)

- **`klodi_list_create.expires_hours` description rewritten.** Was "Hours until expiry (default 1440)"; now "Hours until expiry. Omit (or pass null) for no expiry — the default. Set a positive integer to give the listing a TTL." Conveys the new server-side semantics: listings without a TTL are now first-class, not the 60-day fallback they used to be.
- **`klodi_list_update` tool description extended.** Appends the `expires_hours`/clear-expiry contract so agents reading the tool description (rather than only the param schema) discover the new affordance.

### Added (`klodi-zeroclaw` 0.2.12)

- **Klodi inbox module** (`klodi_rust_host::inbox`, gated on `zeroclaw_session`). New sibling of `klodi_rust_host::channels` containing:
  - `parser.rs` — parses the canonical `── klodi · req=<id> · klodi_escalate_to_user ──` frame `dashboard::render_payload` produces back into a structured `Escalation`. Other plugin-prefixed event kinds (`offer.accepted`, `channel.opened`, …) share the frame header but a different middle slot — they are rejected here so the filter doesn't surface them as escalations.
  - `filter.rs` — `open_escalations(session_messages, klodi_home)` returns `Vec<OpenEscalation>` by walking the dedicated session's REST history, parsing every `klodi_escalate_to_user` frame, and filtering out ones whose reply was already persisted to `${KLODI_HOME}/approvals/<rid>.reply.json` by the existing approval bridge.
  - `civil.rs` — internal helpers for rendering reply prefixes; kept private so the inbox UI doesn't need to know the wire format.
  - `handlers.rs` — `InboxState`, `build_escalations_response`, `handle_escalations_request`, `handle_reply_request`, and the embedded `INBOX_HTML` SPA (read at compile time via `include_str!("../../assets/inbox.html")`). Handlers stay HTTP-agnostic; the shim handles wire framing.
- **`packages/klodi-rust-host/assets/inbox.html`** — single-file SPA the embedded `INBOX_HTML` references. Loopback-only delivery; no external CDN.
- **Three new HTTP routes on the pairing-shim listener:**
  - `GET /inbox/` — serves `INBOX_HTML` with `Content-Type: text/html; charset=utf-8`.
  - `GET /inbox/api/escalations` — JSON list of open escalations from `open_escalations(...)`.
  - `POST /inbox/api/reply` — writes the operator's reply into the dedicated klodi session via `zeroclaw_ws::send_session_message(..., SendAckPolicy::OnAgentObservation, ...)`.
- **`ShimHandle::serve_with_inbox(minter, Option<InboxState>)`** — new entry point. `ShimHandle::serve(minter)` is retained as a thin wrapper that delegates with `None`, leaving `/inbox/*` routes returning 404 for hosts that don't want the inbox.
- **`InboxState` re-export from `klodi_rust_host`** (feature-gated on `zeroclaw_session`). Adapters constructing the daemon binary build it from the resolved `ZeroClawWsConfig` + `klodi_home`.
- **`${KLODI_HOME}/zeroclaw.inbox-url`** — the daemon writes the inbox URL (`http://127.0.0.1:<port>/inbox/`) to this file on every boot so the demo `up` script and future bookmark integrations can surface it without grepping logs. Non-fatal on write failure; the URL also prints in the human-readable pair block.
- **Pair-block prints the inbox URL.** `print_pair_block` now takes an optional `inbox_url` and surfaces it alongside the pairing-helper URL so the operator sees both at boot.
- **Tracing breadcrumbs** for the inbox lifecycle: `klodi_zeroclaw_inbox_state_build_failed_disabling_inbox` (warn — `InboxState::new` failed, daemon falls back to inbox-less `serve`), `klodi_zeroclaw_inbox_url_persisted` (info — URL file written), `klodi_zeroclaw_inbox_url_persist_failed` (warn — non-fatal). `klodi_zeroclaw_shim_listening` gains an `inbox_mounted` field.

### Changed (`klodi-zeroclaw` 0.2.12)

- **`DashboardChannel::notify` always returns `Err`.** The function body is gone; calls fall through the registry's agent-chain to the next-highest-floor agent surface (the dedicated klodi session). `agent_surface()` deliberately keeps returning `true` so the registry still threads the dashboard into its agent chain — reverting to `false` would push the channel into the non-agent fan-out path and re-introduce the write we are explicitly removing.
- **`DashboardChannel::replies()` polling stays alive.** Capturing operator-typed replies for `${KLODI_HOME}/approvals/<rid>.reply.json` (used by the approval gate) is orthogonal to writes and survives this change unchanged.
- **Five `DashboardChannel` helpers retained but annotated `#[allow(dead_code)]`:** `resolve_destination`, `verify_or_reroute_destination`, `record_adjacency`, `list_sessions`, `list_messages`. Slated for reuse by the inbox surface when future cuts wire T3 active-session resolution + stale-session pre-checks into the inbox poll loop (see §5.6 of the inbox plan).
- **Pairing-shim request buffer cap: 2 KiB → 16 KiB.** The pairing routes only need request line + Host header (a few hundred bytes); the inbox `POST /inbox/api/reply` accepts a JSON body containing the operator's free-form reply. 16 KiB comfortably covers a multi-paragraph reply without permitting an attacker to make us alloc much.
- **`BodyShape::Debug` derived once with a cfg-gated match arm** instead of two cfg-split impls (positive `zeroclaw_session` + negative). The split confused `adapters/zeroclaw/scripts/vendor.py`, which strips `#[cfg(feature = "zeroclaw_session")]` lines but leaves `#[cfg(not(feature = "zeroclaw_session"))]` intact — at publish time the staged crate ended up with both impls live, conflicting. Mirrors the `mcp/tools.rs::dispatch` convention.
- **`adapters/zeroclaw/scripts/vendor.py` stages `assets/inbox.html`** at `<staged>/src/assets/inbox.html` so the `include_str!("../../assets/inbox.html")` in `inbox/handlers.rs` resolves inside the staged crate.

### Migrating from 0.2.x to 0.2.12

**Schema change — every adapter, every agent.** Treat `expires_at` as `string | null` on every klodi listing reply. Agents that compare `expires_at` to a deadline, parse it as a date, or surface it in UI must null-check first. To pass through the new affordance: `klodi_list_create` keeps the old "omit for default TTL" behaviour but now defaults to no expiry instead of 1440 hours; pass `expires_hours: <positive int>` for the old behaviour, or `null` (or omit) for indefinite. `klodi_list_update` agents can now refresh or clear a listing's TTL without withdrawing and relisting — `{listing_id, expires_hours: 720}` resets the TTL to 30 days from now; `{listing_id, expires_hours: null}` removes the expiry.

**klodi-zeroclaw operators.** Drop-in. The inbox auto-mounts on the existing pairing-helper listener — the operator visits `http://127.0.0.1:<port>/inbox/` (URL surfaced in the pair-block and persisted to `${KLODI_HOME}/zeroclaw.inbox-url`). Approval-gate replies still land in `${KLODI_HOME}/approvals/<rid>.reply.json` via `DashboardChannel::replies()`; no changes there.

**Out-of-tree consumers of `klodi_rust_host` building a daemon.** `ShimHandle::serve(minter)` continues to work — same behaviour as before, no inbox routes. Hosts that want the inbox surface call `ShimHandle::serve_with_inbox(minter, Some(InboxState::new(ws_config, klodi_home)?))` instead. `InboxState` is feature-gated on `zeroclaw_session`; non-zeroclaw hosts can ignore the new symbol entirely.

### Out of scope (follow-ups tracked separately)

- **Server-side TTL default.** The schema description for `klodi_list_create.expires_hours` now reads "Omit (or pass null) for no expiry — the default", which matches the new wire contract but only takes effect once the marketplace handler stops imposing the 1440-hour fallback. The handler change is tracked in the marketplace repo, not here.
- **Inbox T3 active-session resolution.** The inbox today polls the dedicated klodi session. The retained `DashboardChannel::resolve_destination` / `verify_or_reroute_destination` helpers wire into the inbox poll loop in a follow-up so the inbox can additionally surface escalations targeted at the operator's most recently active dashboard session.
- **Inbox auth.** The inbox listener is loopback-only and inherits the pairing-shim's threat model (workstation owner is the trust anchor — see `SECURITY.md` and the `feedback_trust_scope_workstation_owner.md` memory). A future cut may add an `Authorization: Bearer` check against the same pair-code the helper mints, for hardened deployments where the loopback assumption is too generous.
- **Inbox reply correlation in the dedicated session.** Today the reply lands in the dedicated session as a plain operator message; the autonomous agent recognises it via conversational context. A `req=<id>` echo in the reply body would let the agent correlate replies to their originating escalation when many are in flight.

## [0.2.11] — 2026-05-11

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

Session-routing rewrite. On 0.2.10, `klodi-zeroclaw-daemon` minted one dedicated session at boot and pinned every wake AND every `klodi_report_to_operator` call to that session for the life of the container — the dashboard tab the operator typed into got a different session id, the daemon never learned about it, and every klodi event after the operator's first reply went to the silent dedicated tab. 0.2.11 replaces the pinned-session model with **single-destination severity-based routing plus an agent-initiated escalation tool**. Each wake lands in exactly one session — no fan-out, no duplicate agent turns. The autonomous agent in the dedicated klodi session calls `klodi_escalate_to_user` (renamed from `klodi_report_to_operator`) when it can't proceed without the human; the tool writes a klodi-prefixed message into the operator's most recently active dashboard session.

### Added (`klodi-zeroclaw` 0.2.11)

- **Single-destination routing in `ChannelRegistry`.** New `route_wake(notif) -> RouteOutcome` + `notify(notif) -> RouteOutcome` on `klodi_rust_host::channels::ChannelRegistry`. Both pick the channel with the highest `severity_floor` that still accepts the notification (the channel "closest to the operator"), call it, and return `RouteOutcome { destination_channel, posted, correlation_id }`. Upstream channels (Telegram, Slack, email — `agent_surface=false`) fan alongside the picked agent route since they don't trigger server-side agent loops. `route_wake` unconditionally bypasses the registry's batching window; `notify` honours it (used by `klodi_escalate_to_user` and the approval gate, where noisy event kinds want coalescing).
- **`RegisteredChannel.agent_surface: bool`** distinguishes ZeroClaw-session channels (dedicated, dashboard — `true`) from notification-only sinks (`false`). Single-destination routing applies only among `agent_surface=true` channels to avoid firing multiple server-side agent loops on the same payload.
- **`klodi_escalate_to_user`** MCP tool. Renamed from `klodi_report_to_operator`. Sharper semantics ("escalate" = autonomous agent yielding to the user, "to_user" = workstation owner as trust anchor). Implementation: routes via `registry.notify` — the registry picks the highest-floor agent surface accepting the severity (the dashboard for `ApprovalRequest` / `OperatorImportant`) and falls through to lower-floor surfaces on Err, so the dedicated klodi session is the natural backstop when the dashboard's T3 returns no operator-typed session. Returns `{ posted, destination_channel, session_id, severity, correlation_id }`; `posted: false` only when every accepting agent surface failed, in which case the MCP tool surfaces an error rather than a structured response.
- **`BodyShape::ZeroClawRegistry { registry, dedicated_session_id }`** in `klodi_rust_host::forwarder`. Replaces the 0.2.10 `BodyShape::ZeroClawSession { ws_config, session_id }` single-target variant. The forwarder calls `registry.route_wake(notif)` for each wake; the registry's descending-floor chain tries the dashboard first and falls through to the dedicated session (the lowest-floor agent surface) on Err. The forwarder NAKs only when every accepting agent surface failed — including the dedicated backstop — so JetStream redelivers.
- **Dedicated-session-only fallback registry.** When `build_channel_registry` fails at daemon startup (malformed `klodi.toml`, on-disk artifact failure, …) the daemon constructs a minimal `ChannelRegistry` containing just the `DedicatedSessionChannel` so wake forwarding keeps working while the operator fixes their config.
- **Routing-decision logs.** Grep-friendly tracing event names:
  - `klodi_zeroclaw_target_session_resolved` (dashboard T3 picked a destination), `klodi_zeroclaw_target_session_unresolved` (no candidate; the registry falls through to the next-highest-floor agent surface — typically the dedicated session).
  - `klodi_zeroclaw_dashboard_channel_registered` (fires once at construction with REST/WS endpoints + poll interval).
  - `klodi_zeroclaw_channel_registry_ready` (fires once at daemon boot with the channel-name list + dashboard-enabled flag + dedicated-session id).
  - `klodi_zeroclaw_no_accepting_agent_channel` (route fired but no agent-surface channel accepted the notification — typically a misconfigured `event_filter`).
  - `klodi_zeroclaw_channel_notify_failed_falling_through` (per-step warn — one agent surface's `notify` returned Err; the registry tries the next-highest-floor surface).
  - `klodi_zeroclaw_every_agent_channel_failed` (terminal warn — every accepting agent surface failed in turn; `posted=false` returned to the caller).
  - `klodi_wake_forwarded_via_ws` carries `destination`, `severity`, `event_kind`, `event_id`, `dedicated_session_id`.
  - `klodi_wake_forward_every_channel_failed` (warn — registry's chain was exhausted; forwarder NAKs so JetStream redelivers).

### Fixed (`klodi-zeroclaw` 0.2.11)

- **Wakes reach the right session without duplicate agent turns.** Wake routing is per-severity, single-destination:
  - `Diagnostic` (`channel.message`, `channel.opened`, `channel.closed`) → dedicated klodi session. Channel-lifecycle is autonomous-agent territory: `channel.opened` starts the negotiation thread the klodi-session agent runs itself; the operator's dashboard agent has no context to act on a new channel.
  - `Operator` (`listing.*`, `search.match`, `offer.proposed`, `offer.rejected`) → dedicated klodi session.
  - `OperatorImportant` (`offer.accepted`, `transaction.completed`, `transaction.cancelled`) → operator's active dashboard session.
  - `ApprovalRequest` (gated-tool prompts via the approval gate) → operator's active dashboard session.
  - Fallback for the high-severity branches: when the dashboard's T3 finds no operator-typed session, fall back to the dedicated klodi session so headless / operator-offline deployments still surface the event to the autonomous agent.
- **Approval prompts reach the operator on a single surface.** The 0.2.11-intermediate approval-fan-to-all-tabs path is gone — duplicate agent turns would race the approval-reply bridge. The gate now posts the prompt to the operator's active dashboard session (or dedicated as fallback) and the reply bridge releases the gate when the operator replies on that surface.
- **`klodi_escalate_to_user` tool description matches actual routing.** Spells out the single-destination + agent-driven model and the `── klodi · req=…` prefix's role as a no-op signal for the operator's dashboard agent.
- **Skill-bundle guidance for `klodi_escalate_to_user` deferred.** The universal `skill/SKILL.md` and `skill/references/tool_inventory.md` ship to every adapter (OpenClaw, the Python adapters, every Rust host), so we deliberately do NOT carry zeroclaw-specific session-routing prose or the two-agent dashboard/dedicated split there in 0.2.11. The agent-facing how-to (when to call, severity meanings, the `── klodi · req=…` header conventions, the dashboard agent's no-op rule) lives in the `klodi_escalate_to_user` tool description itself (`packages/klodi-rust-host/src/mcp/tools.rs` — gated on `#[cfg(feature = "zeroclaw_session")]` so only zeroclaw agents see it). Moving the richer guidance into SKILL.md behind `<!--adapter:zeroclaw-->` markers is tracked separately.

### Changed (`klodi-zeroclaw` 0.2.11)

- **`BodyShape::ZeroClawSession { ws_config, session_id }` removed; `BodyShape::ZeroClawRegistry { registry, dedicated_session_id }` replaces it** (public API break since 0.2.10 for out-of-tree consumers of `klodi_rust_host`). In-tree callers updated. Out-of-tree consumers building a daemon must construct a `ChannelRegistry` via `build_channel_registry(...)` and pass it on `body_shape`. The `klodi-zeroclaw-daemon` source is the canonical example.
- **`klodi_report_to_operator` renamed `klodi_escalate_to_user`.** Tool-name break for agents written against the prior name; they get `unknown klodi tool: klodi_report_to_operator` on call. SKILL.md §7a is the single source of truth for the rule the agents follow.
- **`RegisteredChannel` requires a new `agent_surface: bool` field.** Out-of-tree consumers constructing custom `RegisteredChannel` values must set it explicitly. In-tree factory updated (dedicated + dashboard: `true`; upstream: `false`).
- **Forwarder's WS-handshake backoff helpers removed.** 0.2.10's `ws_backoff_for` + `WS_BACKOFF_CAP_ATTEMPTS` + the per-daemon `AtomicU32` failure counter are gone — per-channel error handling takes over, and JetStream's redelivery cadence supplies the practical jitter. The `klodi_zeroclaw_ws_backoff_before_send` log is therefore gone too.
- **Forwarder lock renamed `zeroclaw_session_lock` → `zeroclaw_dispatch_lock`.** Still per-daemon, still held across the dispatch cycle; now wraps `registry.route_wake` + fallback rather than a single WS handshake.

### Migrating from 0.2.10 to 0.2.11 (klodi-zeroclaw operators only)

Drop-in for the operator side. The daemon's behaviour change is strictly routing — no flag changes, no `${KLODI_HOME}` migration, no `klodi.toml` schema updates. Existing `klodi.toml` files continue to work; the new routing reads the same `[notifications.dashboard]` block 0.2.9 introduced.

**For agents** (host runtimes that have klodi MCP tools available): rename `klodi_report_to_operator` calls to `klodi_escalate_to_user`. The argument schema is unchanged. The previous tool name is no longer registered — agents calling the old name get `unknown klodi tool`. If your skill bundle is loaded via the embedded resource path (`klodi://skill/SKILL.md`), the new §7a guidance + the renamed entry in `references/tool_inventory.md` is what the agent reads.

**For out-of-tree consumers** of `klodi_rust_host` building a daemon: replace `BodyShape::ZeroClawSession` construction with `BodyShape::ZeroClawRegistry { registry, dedicated_session_id }` plus a `ChannelRegistry` built via `build_channel_registry`. Add `agent_surface: bool` to any `RegisteredChannel` you construct manually.

### Out of scope (follow-ups tracked separately)

- **ZeroClaw assistant-inject endpoint.** Today `/ws/chat` only accepts `{"type":"message",…}` which persists as `role=user` AND fires a server-side agent loop in the target session. Klodi's escalations into the operator's dashboard therefore fire that session's dashboard agent, which we mitigate via the `── klodi · req=…` prefix + the SKILL.md §7a no-op rule (cost: one wasted dashboard turn per escalation). A first-class `role=assistant` inject endpoint would replace the prefix workaround with proper gateway semantics. Tracked as a separate ZeroClaw repo plan.
- **Persistent escalation queue when no operator session is active.** Today escalations fall back to the dedicated session when T3 finds nothing operator-typed. A persistent queue + drain-on-dashboard-open would let escalations wait passively for the operator. Defer until a real-use case shows up.
- **Replay missing wakes to the dashboard agent when the operator opens a tab mid-stream.** An operator who opens the dashboard after several wakes have routed to the dedicated session misses those — the dashboard agent has no chat history to read. A "catch-up summary" the dashboard agent posts on its first turn would close the gap. Track separately.
- **Per-instance routing for ambiguous wake kinds.** The static `default_severity_for_event` table makes `channel.message` always-diagnostic. A future refinement would let the autonomous agent flag a specific wake as "actually this one needs the operator" and re-route mid-flight. Today the agent uses `klodi_escalate_to_user` instead.

## [0.2.10] — 2026-05-11

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

Cold-start latency fix. On 0.2.9, the daemon took ~360s (cold) / ~180s (warm) from `klodi_zeroclaw_paired_from_sidecar` to `klodi_daemon_connected` because two bootstrap WS writes (heartbeat + intro note) sat serially on the startup critical path, each waiting up to 180s for an `agent_start` frame that never arrives at session-mint time (no agent loop is attached yet). 0.2.10 brings cold to ~5s and warm to ~0s by separating bootstrap-write semantics from wake-delivery semantics and moving the bootstrap writes off the critical path.

### Added (`klodi-zeroclaw` 0.2.10)

- **`SendAckPolicy` enum** in `klodi_rust_host::zeroclaw_ws`. Public API addition. Threads through `send_session_message` and `bootstrap_session_with_first_message` so each call site declares its operational regime:
  - `OnGatewayWrite` — bootstrap regime, no agent expected. After the WS frame flushes, reads inbound frames for `SEND_ERROR_GRACE` (5s) strictly to surface gateway `error` frames (auth, schema mismatch, session-not-found). Window elapsing or a clean WS close is the success signal. Does NOT wait for `agent_start`; the constant is sized for protocol latency, not agent-turn duration. Used by `resolve_session_id`'s atomic first-write and by `post_startup_notes`.
  - `OnAgentObservation` — wake-delivery regime, agent expected to be live. Existing behaviour: waits up to `DRAIN_TIMEOUT` (180s) for `agent_start` as a positive visibility signal, falls back to ack-on-write on timeout with a warn log. Used by the forwarder, the MCP `klodi_report_to_operator` tool, and every `OperatorChannel` implementation (dedicated session, dashboard).

### Fixed (`klodi-zeroclaw` 0.2.10)

- **Cold-start gap (`paired_from_sidecar` → `klodi_daemon_connected`) collapses ~360s → ~5s.** The atomic bootstrap-write inside `resolve_session_id` now uses `OnGatewayWrite`, returning in ~5s instead of 180s when the freshly-minted session has no agent attached. Separately, `post_startup_notes` is now `tokio::spawn`'d off the critical path so the daemon's NATS dial, reply-attribution task, and operator-facing pair block proceed as soon as the session resolves — the heartbeat and intro-note WS writes are bootstrap breadcrumbs, nothing downstream waits on them landing.
- **Warm-restart gap collapses ~180s → ~0s.** On a warm restart (`freshly_minted=false`, persisted `zeroclaw.session`), the surviving heartbeat WS write in `post_startup_notes` was the sole remaining drain on the critical path. With `OnGatewayWrite` + spawn'd execution, warm-restart `klodi_daemon_connected` lands within seconds of pairing.
- **Pairing-helper URL operator-usable from `t=0`.** `ShimHandle::serve(minter)` is now spawned immediately after `ShimHandle::bind`, before any WS writes. Previously the accept loop ran AFTER the bootstrap drains — meaning `klodi_zeroclaw_shim_bound url=…` was logged at boot but the URL refused connections (then stalled on accept) for the entire 6-minute cold-start window. Operators reading the helper URL from the logs no longer get a connection-refused / silent-timeout staircase.
- **`klodi_zeroclaw_ws_drain_timeout_after_send` no longer fires on startup.** The 180s drain was a wake-regime guard-rail that was incorrectly engaged by bootstrap writes. Bootstrap writes that previously logged this warning at `+180s` and `+360s` now log `klodi_zeroclaw_ws_send_error_grace_elapsed` at `debug` after ~5s — a non-event, not a warn-worthy ack-on-write fallback.

### Changed (`klodi-zeroclaw` 0.2.10)

- **`send_session_message` and `bootstrap_session_with_first_message` signatures take a new `SendAckPolicy` parameter** (public API break for out-of-tree consumers of `klodi_rust_host`). All in-tree callers updated. Out-of-tree consumers pick `OnAgentObservation` for wake-style writes (agent expected to observe) and `OnGatewayWrite` for bootstrap-style writes (no agent attached at write time). See the `SendAckPolicy` docstring in `klodi_rust_host::zeroclaw_ws` for the decision tree.
- **`post_startup_notes` (internal to `klodi-zeroclaw-daemon`)** now takes a pre-composed `Option<&str>` bootstrap-note body instead of a `BootstrapInputs<'_>` reference, so the spawned task carries owned strings rather than borrows into the main task's stack.

### Migrating from 0.2.9 to 0.2.10 (klodi-zeroclaw operators only)

Drop-in for the operator. The daemon's behaviour change is strictly latency — no flag changes, no `${KLODI_HOME}` migration, no `klodi.toml` schema updates.

Out-of-tree consumers of `klodi_rust_host` who call `send_session_message` or `bootstrap_session_with_first_message` directly must add a `SendAckPolicy` argument at every call site. The right pick is almost always `SendAckPolicy::OnAgentObservation` unless the write is happening before any agent loop is attached.

## [0.2.9] — 2026-05-11

### Added (`klodi-zeroclaw` 0.2.9)

> Targets `klodi-zeroclaw 0.2.9`. OpenClaw, the Python adapters
> (klodi-hermes, klodi-nanobot), and the other Rust adapters
> (klodi-moltis, klodi-ironclaw) are unaffected and not republished
> at this version.

The operator-visibility follow-up to the wake-routing changes that shipped in 0.2.6. Notifications and approval prompts now reach every surface the operator might be looking at (dashboard + dedicated klodi session + any operator-configured upstream channels like Telegram/Slack/email).

- **`OperatorChannel` trait + `ChannelRegistry`** in `klodi_rust_host::channels`. Trait mirrors upstream's `(channel_id, recipient, message)` shape so a future host (Hermes, Moltis) can plug new channel types in without touching the dispatch loop. Three implementations land in 0.2.9:
  - `DashboardChannel` — klodi-owned WebSocket transport against `/ws/chat`. Uses the T3 active-session heuristic (most-recent session in `/api/sessions` whose latest message has `role=user` and that isn't in the created-sessions ledger) to find where the operator is currently typing.
  - `DedicatedSessionChannel` — adapter exposing the existing dedicated klodi session as an `OperatorChannel` so registry-driven fan-out treats every surface uniformly.
  - `UpstreamChannel` — delegating wrapper over `zeroclaw channel send <message> --channel-id <id> --recipient <r>`. Klodi does NOT re-implement Telegram/Slack/Discord/etc. clients; upstream's `[reliability]` config owns retry/backoff per medium.
- **`ChannelInvoker::Shell`** (`klodi_rust_host::channels::invoker`) — the transport `UpstreamChannel` wraps. 0.2.9 shells out to the `zeroclaw` CLI (same dependency as the pairing-helper auto-mint). Future variants (`Library`, `Rest`) land here when upstream exposes a stable Rust or REST surface. The MCP binary now accepts `--zeroclaw-cli` / `ZEROCLAW_CLI` (default `"zeroclaw"`), matching the daemon's flag. Both binaries thread the path through to `ChannelInvoker::Shell` so upstream channel sends work on non-canonical deployments where the `zeroclaw` binary isn't on `PATH`.
- **`${KLODI_HOME}/klodi.toml` `[notifications]` block** — operator-side channel wiring. Missing file = defaults (dashboard auto-active-session enabled, dedicated session always-on, no upstream channels). Schema:
  ```toml
  [notifications]
  batch_window_seconds = 5

  [notifications.dashboard]
  enabled = true
  recipient = "auto"            # T3 active-session
  severity_floor = "operator_important"

  [notifications.dedicated_session]
  enabled = true
  severity_floor = "diagnostic" # see everything

  [[notifications.upstream]]
  channel_id = "telegram"       # MUST be in `zeroclaw channel list`
  recipient = "123456789"
  severity_floor = "approval_request"
  ```
  Upstream channel ids are validated against `GET /api/channels` at daemon startup — unknown ids surface as `klodi_zeroclaw_upstream_channel_unknown` warn logs and are skipped (operator runs `zeroclaw onboard channels` to register the channel, then restarts the daemon).
- **Approval prompts fan out across every enabled channel.** Plugin-gated tools (`klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_list_withdraw`) post the prompt to dashboard + dedicated session + every configured upstream channel. The operator can reply via the dashboard (`/klodi yes:<reqId>` or a bare `yes` within 60s) OR the dedicated klodi session — whichever reply lands first releases the gate. Upstream channels are notification-only in 0.2.9; an operator paged on Telegram must release the gate via dashboard or dedicated session.
- **`/klodi` dashboard reply prefix + bare-affirmation window.** The dashboard channel's polling reply bridge recognises:
  - `/klodi yes:<reqId>` / `/klodi no:<reqId>` — explicit verb + correlation. Both case-insensitive on the `/klodi` prefix.
  - Bare `yes` / `no` / `approve` / `deny` / `confirm` / `cancel` within 60s of an open notification (vocabulary refined via real-use feedback).
- **`klodi_report_to_operator` routes through the registry** when one is configured. The tool now appears on every enabled surface, not just the dedicated session. Severity → channel mapping:

  | Severity | Dashboard | Dedicated session | Upstream |
  |----------|-----------|-------------------|----------|
  | ApprovalRequest | dispatch | dispatch | dispatch |
  | OperatorImportant | dispatch | dispatch | dispatch |
  | Operator | drop | dispatch | drop |
  | Diagnostic | drop | dispatch | drop |
- **Stale-session detection (T5).** Before writing to a destination the channel expects non-empty, `GET /api/sessions` verifies membership AND `message_count > 0`. On detection: log `klodi_zeroclaw_session_resurrection_detected`, record the old id in the created-sessions ledger, post a one-line "🔁 klodi notice — this dashboard session was recreated" breadcrumb in the resurrected session, re-resolve via T3.
- **New artifacts under `${KLODI_HOME}`** (all mode 0600):
  - `zeroclaw.dispatcher_cursor.json` — per-session last-processed-message index for the dashboard reply bridge. Survives daemon restarts.
  - `zeroclaw.created_sessions` — JSON list of session ids klodi has ever written to. Excluded from T3 candidates so klodi never picks its own session as "where the operator is."
  - `approvals/<request_id>.reply.json` — captured operator reply per approval. Written by the daemon's reply-attribution task; read by the MCP server's approval gate when the agent retries without explicit text.
- **Severity-driven dispatch with per-channel filters + batching window.** Each registered channel has a `severity_floor` and optional `event_filter`. The registry's batching window (default 5s, configurable via `klodi.toml`) drops subsequent notifications of the same `event_kind` within the window for the dashboard + upstream surfaces; `ApprovalRequest` bypasses batching unconditionally; the dedicated klodi session sees everything regardless (severity floor = `diagnostic` by default).

### Changed (`klodi-zeroclaw` 0.2.9)

- **`klodi_rust_host::mcp::handler::OperatorChannel` (struct) → `KlodiSessionTarget`** (public API break for out-of-tree consumers of `klodi_rust_host`). The name was reclaimed by the new `klodi_rust_host::channels::OperatorChannel` trait — the renamed struct names what it always was (the dedicated klodi session binding). Internal callers (zeroclaw bin, mcp tools) updated. Out-of-tree consumers should swap `use klodi_rust_host::mcp::OperatorChannel` → `use klodi_rust_host::mcp::KlodiSessionTarget`.
- **Bootstrap-note copy** now lists the multi-surface model — heartbeat surfaces the count of configured channels; the bootstrap note explains that notifications appear in dashboard + dedicated session + each configured upstream channel.

### Migrating from 0.2.8 to 0.2.9 (klodi-zeroclaw operators only)

Drop-in for the default case. The dashboard channel layers on top of the existing dedicated session; default `klodi.toml` is "no file" = sensible defaults.

For operators who want the v0.2.8 single-surface behaviour (dedicated session only): set `notifications.dashboard.enabled = false` in `${KLODI_HOME}/klodi.toml` (file may not yet exist — create it).

For operators who want to receive notifications on Telegram / Slack / email / etc.:
1. Run `zeroclaw onboard channels` (interactive upstream tooling) to register the channel.
2. Add a `[[notifications.upstream]]` block to `${KLODI_HOME}/klodi.toml`:
   ```toml
   [[notifications.upstream]]
   channel_id = "telegram"
   recipient = "123456789"
   severity_floor = "approval_request"  # only approvals
   ```
3. Restart `klodi-zeroclaw-daemon`. The daemon validates the channel id against `GET /api/channels` at startup — typos surface as `klodi_zeroclaw_upstream_channel_unknown` warn logs.

Reply mechanism: the operator can release approval gates from the dashboard (`/klodi yes:<reqId>`) OR the dedicated klodi session (same as v0.2.8 — agent reads the reply inline). Upstream channels are outbound-only in 0.2.9; an operator paged on Telegram must release the gate via dashboard or dedicated session.

## [0.2.8] — 2026-05-10

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

This release closes the dashboard pairing-friction gap. Operators on the canonical "cargo install + run daemon" deployment now go from `klodi-zeroclaw-register` straight to a working dashboard with a single ⌘V + Enter, without `docker exec` or hunting for the gateway's startup pairing code in container logs.

### Added

- **Auto-mint daemon pairing.** When no `ZEROCLAW_AGENT_TOKEN`, no cached `${KLODI_HOME}/zeroclaw.token`, and no sidecar `${KLODI_HOME}/zeroclaw.pairing-code` are present, the daemon now mints its own pairing code by invoking `zeroclaw gateway get-paircode --new` on `PATH` and POSTs it to `/pair` itself. The minted bearer is cached as before. First-boot is zero-touch: the operator no longer has to find the gateway's startup pairing code printed in container logs and write it to a file. Sidecar codes still take precedence — operators who control re-pair flow manually keep the existing semantics.

- **Loopback browser-pairing helper.** `klodi-zeroclaw-daemon` 0.2.8 binds a small HTTP/1.1 server on `127.0.0.1:<port>` (default port 0 = OS-picked ephemeral). Hitting `/` mints a fresh pairing code via the same gateway CLI, renders an HTML page that copies the code to clipboard, and redirects to the gateway dashboard URL. The dashboard's "PAIRING REQUIRED" prompt becomes a single ⌘V + Enter. Codes are minted on every page hit so reloads always produce fresh codes (codes expire ≈60s server-side). The shim's URL is surfaced through three channels:
  - **Heartbeat in the operator's chat session** — the existing one-line `🟢 klodi daemon connected as @…` heartbeat now carries `Browser pairing: <url>` when the helper is running.
  - **Boxed stdout block** at daemon startup with the URL and a freshly-minted code (so even non-interactive deployments see it in logs).
  - **Auto-launch** of the operator's browser at the URL when stdout is a tty (override via `--open-browser={auto,always,never}` / `ZEROCLAW_OPEN_BROWSER`).

  The shim's threat model: loopback bind only (hardcoded 127.0.0.1, never widened by CLI), `Host:` header validation against `127.0.0.1:<port>` / `localhost:<port>` literals (DNS-rebinding defense), `Cache-Control: no-store` + `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff` headers, HTML-safe JSON encoding inside the inline `<script>` (`<` / `>` / `&` rewritten as `\uXXXX` so a hostile dashboard URL can't break out of the script element). Per the repo's `SECURITY.md` trust model, the workstation owner is the trust anchor — local processes running as the operator are inside the boundary, so no PIN / CSRF token is added.

- **New CLI flags on `klodi-zeroclaw-daemon`.** All env-var-backed:
  - `--zeroclaw-cli` (`ZEROCLAW_CLI`, default `zeroclaw`) — path to the gateway CLI used by auto-mint and the shim. When unreachable, both auto-disable and the daemon falls back to the 0.2.7 bearer-resolve flow.
  - `--no-browser-pair-shim` (`ZEROCLAW_BROWSER_PAIR_DISABLE`) — opt out of auto-mint + shim entirely. Use for non-canonical deployments or to keep behaviour identical to 0.2.7.
  - `--browser-pair-shim-port` (`ZEROCLAW_BROWSER_PAIR_PORT`, default `0`) — pin a specific loopback port; default is OS-picked ephemeral.
  - `--zeroclaw-dashboard-url` (`ZEROCLAW_DASHBOARD_URL`) — override the dashboard URL surfaced to the operator. Default: derived from `--zeroclaw-webhook-url` by stripping `/webhook`. Set this when the daemon runs in a container with port-mapped access from the host (e.g. `http://localhost:18793`).
  - `--open-browser={auto,always,never}` (`ZEROCLAW_OPEN_BROWSER`, default `auto`) — controls the OS-native browser launch. `auto` honours tty detection (interactive run = on, systemd / docker compose = off).

### Removed

- **`--legacy-webhook` / `ZEROCLAW_LEGACY_WEBHOOK` (and `BodyShape::MessageWrapped`).** The pre-0.2.6 wake-delivery path that POSTed each event to ZeroClaw's `/webhook` was deprecated in 0.2.6 when wakes moved to `/ws/chat`, retained as a fallback in 0.2.5–0.2.7, and is now removed entirely. Audit confirmed no deployment was setting the flag — every supported gateway (≥ 0.7.4) exposes `/ws/chat`, and the legacy path was unusable in practice on real klodi turns (gateway's hard 30s `TimeoutLayer` vs. typical 60s+ agent turns). Operators on a hypothetical pre-0.7.4 ZeroClaw build that doesn't expose `/ws/chat` would have to stay on klodi-zeroclaw 0.2.7. Touched files: `packages/klodi-rust-host/src/forwarder.rs` (variant + match arms + a now-dead test), `adapters/zeroclaw/src/bin/daemon.rs` (CLI flag, env var, branch, `LEGACY_WAKE_POST_TIMEOUT` constant).

### Migrating from 0.2.7 to 0.2.8 (klodi-zeroclaw operators only)

Drop-in replacement for any operator who was on the canonical `/ws/chat` path (the default in 0.2.6+). Rebuild the daemon (`cargo install klodi-zeroclaw` or pull the new container image) and restart. On first boot after the bump:

1. If the gateway CLI is on `PATH` (canonical deployment), the daemon auto-mints + caches its own bearer when no other source is configured. Existing cached tokens / sidecar pairing-code files / `ZEROCLAW_AGENT_TOKEN` continue to work and take precedence.
2. The loopback shim binds on an ephemeral port; its URL appears in the heartbeat in chat, in a boxed stdout block, and (if running interactively) opens automatically in the operator's browser.
3. To keep auto-pair behaviour disabled (mirrors the 0.2.7 bearer-resolve flow): set `ZEROCLAW_BROWSER_PAIR_DISABLE=1`. To keep auto-pair but suppress the browser launch: set `ZEROCLAW_OPEN_BROWSER=never`.

**Operators who were running with `ZEROCLAW_LEGACY_WEBHOOK=1` set:** unset the env var (or remove the flag); 0.2.8 will refuse to parse it. If your gateway lacks `/ws/chat` (any ZeroClaw build < 0.7.4), pin klodi-zeroclaw to 0.2.7. If your gateway has `/ws/chat`, the WS path will Just Work — that's been the canonical path since 0.2.6.

The interim `demo/scripts/up-zeroclaw.sh:200-233` workaround in the marketplace repo (which `docker exec`s `gateway get-paircode --new` and prints the code) becomes redundant once 0.2.8 ships and can be removed in a follow-up.

## [0.2.7] — 2026-05-10

**klodi-zeroclaw only.** Tag-only re-issue of the 0.2.6 redesign plus the build fix it needed to publish. 0.2.6 was tagged at a commit that contained a `#[cfg]` split in `klodi-rust-host::mcp::tools::dispatch` whose `not(feature = ...)` arm survived the zeroclaw vendor's cfg strip — both halves of the split went live in the staged crate, `cargo publish --dry-run` failed on E0382 + E0596, and the tag never actually shipped to crates.io. 0.2.7 collapses the split to a single `let mut args` with `#[allow(unused_mut)]` for the moltis/ironclaw build that doesn't reach the approval-gate path. The 0.2.6 tag remains on the repo for audit trail; nothing was published under that version.

All operator-facing changes are documented in the [0.2.6] section below.

### Migrating from 0.2.5 to 0.2.7 (klodi-zeroclaw operators only)

Identical to the migration described in [0.2.6] below. There is no separate 0.2.6 → 0.2.7 step — 0.2.6 was never published, so operators upgrading from 0.2.5 land on 0.2.7 directly.

## [0.2.6] — 2026-05-10

> **Never published to crates.io.** This tag exists on the repo for audit trail. The actual publish happened from [0.2.7], which adds the one-line build fix that 0.2.6 needed but didn't have. Operators install 0.2.7; 0.2.6 read as a fully-superseded mirror of 0.2.7's notes.

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

This release replaces the `/webhook` wake-delivery path with a session-based path against ZeroClaw's `/ws/chat`, gives the operator visible heartbeat + bootstrap context the moment the daemon connects, and adds a plugin-side approval gate for irreversible klodi tools. Per-message ack handshake is a known gap (the gateway's `agent_start` frame doesn't carry per-message correlation), deferred until wake volume requires it. The 240s `/webhook` timeout band-aid is dropped by default; the legacy path is still selectable via `--legacy-webhook`.

### Changed

- **klodi-zeroclaw wake delivery (P0):** wakes now write into the operator's persisted ZeroClaw session via `WS /ws/chat?session_id=<uuid>` instead of POSTing to `/webhook`. The 30s `TimeoutLayer` on `/webhook` no longer applies — frame writes return as soon as the gateway acknowledges the WS message, decoupling NATS ack semantics from the agent's full turn duration. The forwarder waits up to 180s for a post-send `agent_start` / `turn_complete` confirmation (covers a typical 60s+ agent turn plus one prior in-flight turn draining), then acks the NATS message regardless — the WS write itself is the durability boundary.

  Concretely: `klodi_rust_host::forwarder::BodyShape` gains a `ZeroClawSession { ws_config, session_id }` variant. `klodi-zeroclaw-daemon` builds it from the resolved bearer + the operator-session UUID at startup. The legacy `MessageWrapped` shape against `/webhook` is still selectable with `--legacy-webhook` / `ZEROCLAW_LEGACY_WEBHOOK=1` for operators on a ZeroClaw build that doesn't expose `/ws/chat`.

### Added

- **Persisted operator session (`${KLODI_HOME}/zeroclaw.session`).** The daemon resolves a single ZeroClaw session per persona at startup: read the cached UUID, probe-resume it via WS, and re-bootstrap from scratch if the gateway no longer recognises it. Idempotent across restarts. Mode 0600. Surfaced by `klodi_setup_status` as the new `zeroclaw_session_present` flag.

- **Plugin-authored heartbeat + bootstrap note.** On every daemon connect the operator's session receives a one-line `🟢 klodi daemon connected as @<handle>` heartbeat. On a freshly-minted session the daemon also posts a multi-line bootstrap note covering the wake event kinds, klodi-namespaced tools, and the approval-via-chat convention. Sessions with prior messages skip the bootstrap note so the operator's chat doesn't accumulate identical intros across restarts.

- **`klodi_report_to_operator` MCP tool.** New tool the agent can call to write a structured note (severity + summary + optional details + optional structured payload) directly into the operator's session. Renders as `ℹ️`/`⚠️`/`🛑` headline + markdown body + fenced JSON block. Available only when `klodi-zeroclaw-mcp` finds both `${KLODI_HOME}/zeroclaw.token` and `${KLODI_HOME}/zeroclaw.session` populated (i.e. the daemon has run at least once).

- **Approval gate for irreversible klodi tools.** Hardcoded gated list: `klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_list_withdraw`. First call posts a `🔒 Operator approval needed (request_id: …)` prompt to the operator session, persists pending state under `${KLODI_HOME}/approvals/<request_id>.json` (mode 0600, reaped after 24h), and returns `{ approval_required: true, request_id, instructions }` to the agent. The agent retries with `_klodi_approval_request_id` + `_klodi_approval_operator_text` set to the operator's verbatim chat reply; the plugin matches the args fingerprint, runs an affirmation/denial regex, and either opens the gate or returns a `denied` / `still_pending` response. Pending state is durable across MCP-server crashes.

  **Scope deliberately narrow.** `klodi_offer_respond`, `klodi_list_update`, and other policy-shaped operations are NOT gated by the plugin — the agent reads the operator's `negotiation_style.md` + on-disk strategy files (`${KLODI_HOME}/{buy,sell}/`) and decides whether to call `klodi_report_to_operator` first. This is a deliberate choice: the plugin is mechanism, not policy; locking a "below-min" or "always-ask" pattern inside the plugin would prevent operators who want different workflows from defining them.

- **`klodi-zeroclaw-mcp` operator-channel binding.** New CLI args `--zeroclaw-ws-url` / `--zeroclaw-http-base` (and matching `ZEROCLAW_WS_URL` / `ZEROCLAW_HTTP_BASE` env vars) override the WS endpoint derived from `--zeroclaw-webhook-url`. Useful when the gateway lives at a non-canonical path.

- **`--adopt-session=<uuid>` operator opt-in.** New CLI arg / `ZEROCLAW_ADOPT_SESSION` env var on `klodi-zeroclaw-daemon`. Default behaviour is unchanged (always mint a fresh dedicated klodi session); this flag is the explicit opt-in for operators who want klodi activity to land in an existing chat session. The daemon probes the gateway to confirm the id resumes; bails loudly on any failure so typos don't silently re-bootstrap.

- **Atomic session bootstrap → first-write.** Combined `bootstrap_session` + first heartbeat write into a single WS lifecycle (`bootstrap_session_with_first_message`) so a freshly-minted session always carries at least one durable user-role message before its WS closes. Closes the empty-session GC window observed against the gateway, where empty-session retention behaviour was unverified during research.

- **Per-session write serialisation.** Notifications + channel-message subscribers write into the same operator session from independent forwarder tasks. Added an `Arc<tokio::sync::Mutex<()>>` in `SharedState`, acquired around the full WS connect → send → drain cycle for `BodyShape::ZeroClawSession`, so writes land in NATS-arrival order even if the gateway's `SessionActorQueue` reordering is incomplete. Per-session throughput is bounded by drain time (typically <2s, capped at 180s).

- **WS reconnect backoff.** Added a per-session consecutive-failure counter; before each WS send, if prior sends have failed, sleep for an exponential backoff (250ms base, 2× multiplier, capped at 30s) under the per-session mutex. Reset on success. Keeps NATS redeliveries from hammering a flapping gateway with fresh handshakes — JetStream's redelivery cadence already adds spacing across wakes, this caps the *additional* per-failure wait. Reuses `klodi_nats_client::backoff::compute_backoff` for shared math.

### Changed (internal)

- **Drain protocol simplification.** `zeroclaw_ws::send_session_message` now treats `agent_start` as the sole expected post-send ack frame. The `turn_complete` arm is dropped — it was unobserved during live research against the gateway, and `agent_start` already proves the gateway routed the message into the agent loop. `turn_complete` (and any other future frame) lands in `InboundFrame::Other` and is silently drained.

### Known gaps

- **No per-message WS ack (known gap).** `agent_start` and `turn_complete` aren't tied to the message that triggered them. For a low-volume marketplace this is fine (the wake count rarely outpaces the agent's serial processing); for high-volume marketplaces the daemon could ack a wake before the agent observes it. Acceptable for now; revisit when measured drop rates demand it.

### Migrating from 0.2.5 to 0.2.6 (klodi-zeroclaw operators only)

Drop-in replacement — no config or env changes. Rebuild the daemon (`cargo build -p klodi-zeroclaw --release` or pull the new container image) and restart. The first daemon start after the bump will:
1. Bootstrap a fresh ZeroClaw session and persist its UUID at `${KLODI_HOME}/zeroclaw.session`.
2. Post a heartbeat + bootstrap note into that session — open ZeroClaw's chat dashboard to read them.
3. Switch the forwarder over to WS-based wake delivery — `klodi_wake_forwarded_via_ws` replaces `klodi_wake_forwarded` in the daemon's logs.

If your deployment requires the legacy `/webhook` path for any reason, set `ZEROCLAW_LEGACY_WEBHOOK=1` (or pass `--legacy-webhook`) and the 0.2.5 behaviour is unchanged.

## [0.2.5] — 2026-05-09

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

### Fixed

- **klodi-zeroclaw wake delivery (P0):** every marketplace wake delivered to `klodi-zeroclaw-daemon` 0.2.4 hit `klodi_wake_forward_transport_error` and JetStream redelivered on a 10s cadence; the agent never produced a turn. Root cause: `ForwarderConfig`'s reqwest client used a hardcoded 10s timeout, but ZeroClaw 0.7.4's `POST /webhook` is **synchronous** — the gateway spawns the agent loop, runs it to completion, and returns the agent's reply (`{"model","response"}`) in the response body. Empirically a trivial `{"message":"ping"}` round-trip already takes ~6s with the daemon's cached bearer; real `channel.message` wakes (agent reasons + calls `klodi_channel_message` to reply) routinely take 15–60s, with a long tool-using turn running considerably longer — well past any 10s budget. Each redelivery also stacked a fresh agent init on the gateway since the previous loop was still running. Fix: `ForwarderConfig` gains a per-adapter `wake_post_timeout: Duration` field; `klodi-zeroclaw-daemon` sets it to 240s, which buys generous headroom for the long-turn tail without blocking other deliveries (the forwarder serves notifications and channel messages on independent subscriber tasks, so a slow wake here does not stall others). Moltis + IronClaw stay on 10s since their wake endpoints ack on receipt and run the agent in the background.

### Migrating from 0.2.4 to 0.2.5 (klodi-zeroclaw operators only)

Drop-in replacement — no config or env changes. Rebuild the daemon (`cargo build -p klodi-zeroclaw --release` or pull the new container image) and restart. After the bump, a single `channel.message` wake produces one `Initializing MCP client` line on the gateway, the daemon's logs show `klodi_wake_forwarded`, and the agent's reply lands in the marketplace channel within ~30s.

## [0.2.4] — 2026-05-09

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

### Fixed

- **klodi-zeroclaw wake delivery (P0):** ZeroClaw 0.7.4 retired the `/hooks/wake` route in favor of `POST /webhook`. The old route now falls through to the gateway's SPA static-file fallback, which only serves `GET`/`HEAD` — every wake POST got `405 Method Not Allowed`, NAK'd back into JetStream, and redelivered until `max_deliver` exhausted. Today's container rebuild pulled the new ZeroClaw runtime via the `ghcr.io/zeroclaw-labs/zeroclaw:debian` floating tag, so wakes had been silently failing since the upstream tag moved. The daemon now posts to `/webhook` with `Authorization: Bearer <zc_…>`.

### Changed

- **klodi-zeroclaw `--zeroclaw-hooks-wake-url` / `ZEROCLAW_HOOKS_WAKE_URL` renamed** to `--zeroclaw-webhook-url` / `ZEROCLAW_WEBHOOK_URL` to match the new endpoint name. **Hard break** — the old name is no longer read. Default URL changes from `http://127.0.0.1:7070/hooks/wake` to `http://127.0.0.1:7070/webhook`. Init scripts that exported the old var must update in lockstep with the version bump.
- **klodi-zeroclaw forwarder body shape:** the daemon now wraps the structured wake envelope (`{channel, kind, event_id, user_id, payload}`) as a single JSON-stringified `message` field — `{"message": "<json>"}` — to match ZeroClaw 0.7.4's `/webhook` contract, which only accepts that shape and treats unknown top-level keys as an error. The agent recovers the structured wake by `JSON.parse`-ing the `message` field on receipt. No payload is dropped. Implemented as a new `BodyShape::MessageWrapped` variant on `klodi_rust_host::ForwarderConfig`; Moltis and IronClaw stay on the existing `BodyShape::Structured` path with no behavioral change.

### Added

- **klodi-zeroclaw daemon-side pair bootstrap.** The daemon resolves its bearer at startup in this priority order:
  1. `ZEROCLAW_AGENT_TOKEN` env var (operator manages the token themselves).
  2. `${KLODI_HOME}/zeroclaw.pairing-code` — a sidecar one-time pairing code the operator's init script writes per boot. The daemon POSTs `/pair` with `X-Pairing-Code: <code>`, caches the resulting `zc_<hex>` bearer at `${KLODI_HOME}/zeroclaw.token` (mode 0600), and deletes the consumed code file so it cannot be replayed.
  3. `${KLODI_HOME}/zeroclaw.token` — the cached bearer from a prior successful pair.

  This closes the `gateway.paired_tokens` lifecycle gap: deployments that rewrite ZeroClaw's `config.toml` per container boot (dropping all paired bearers) are now self-healing as long as the same init script also refreshes the sidecar code file. Pair endpoint is derived from the webhook URL by replacing the `/webhook` suffix with `/pair`; override via the new `ZEROCLAW_PAIR_URL` / `--zeroclaw-pair-url` for non-canonical layouts.

### Migrating from 0.2.3 to 0.2.4 (klodi-zeroclaw operators only)

1. Update your init script: rename `ZEROCLAW_HOOKS_WAKE_URL=…/hooks/wake` to `ZEROCLAW_WEBHOOK_URL=…/webhook`. (Or rely on the new default — the daemon now defaults to `http://127.0.0.1:7070/webhook` if the env var is unset.)
2. Provide a bearer source. Either:
    - Export `ZEROCLAW_AGENT_TOKEN=<zc_…>` after pairing manually (call `POST /pair` with `X-Pairing-Code: <code>` against ZeroClaw's gateway), OR
    - Drop the gateway's startup pairing code at `${KLODI_HOME}/zeroclaw.pairing-code` so the daemon can mint + cache the bearer itself. Refresh the file on every container boot if your deployment wipes ZeroClaw's `config.toml`.
3. Confirm ZeroClaw core is ≥ 0.7.4. Older builds shipped the retired `/hooks/wake` route; this adapter no longer targets them.

## [0.2.3] — 2026-05-09

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

### Fixed

- **klodi-{zeroclaw,moltis,ironclaw} wake pump (P0):** the Rust NATS consumer dropped every `search.match` and `channel.message` wake with `klodi_consumer_parse_failed` because `packages/nats-client-rs/src/events.rs` had drifted from the canonical TS wire schema in `packages/tool-catalog/src/events.ts`. Two distinct shapes were affected:
  - `SearchMatchListingSummary` still required the legacy flat `delivery_method` (string) and `location_area` (Option<String>) fields. The publisher (`services/marketplace/src/handlers/listings-search-evaluator.ts`) emits the new `fulfillment: DeliveryOffer[]` shape — a TypeBox-validated discriminated union over `pickup` / `ship` / `digital`. The Rust struct now mirrors the TS source of truth: a new `DeliveryOffer` enum (with `PickupLocation` and `ShipOrigin` value types) replaces the flat triple. Pickup coordinates + area now live INSIDE the offer record, ship offers carry `from.country` + `shipsTo`, and `digital` has no extra fields.
  - `ChannelMessageEvent.sequence` was a required `u64`. The publisher (`packages/nats-client-ts/src/publish.ts`) intentionally does NOT embed sequence in the body — JetStream assigns the stream sequence server-side and it cannot be known at mint time. The field is now `#[serde(default)]` so the parse path succeeds; `consumers.rs::process_channel` populates `event.sequence = msg.info()?.stream_sequence` post-parse, so handlers (and the wake-forward POST body) see the real JetStream sequence rather than a missing field.
  - Cross-language contract test (`tests/contract/golden.rs`) and the shared golden corpus at `packages/tool-catalog/tests/golden/{search.match,channel.message}.json` updated in lockstep. Both fixtures still spoke the dead schema — that gap is why the contract suite previously passed against drifted Rust types. The TS host adapters (OpenClaw, Hermes, Nanobot) consume via `nats-client-ts`, which IS the source of truth, so they were never affected.
- **klodi-{zeroclaw,moltis,ironclaw}-register:** the host `config.toml` merge step now accepts both `[[mcp.servers]]` (headered) and `servers = [{ … }]` (inline) representations of `mcp.servers`. Previously the inline form failed with `[[mcp.servers]] exists but isn't an array-of-tables — refusing to overwrite`, blocking re-runs of register on any `config.toml` rewritten by another writer — e.g. ZeroClaw's daemon persisting `config.toml` after a pairing event, which materializes the headered block as an inline table with the Server struct's default fields (`args`, `headers`). The two TOML forms are semantically identical (both deserialize to the same `Vec<Server>`); the merge step now mutates either form in place, updating only the `klodi` entry while preserving every other entry and the writer's chosen syntax. Rejection is reserved for `mcp.servers` being a non-array or an array containing non-tables.

## [0.2.2] — 2026-05-07

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

This release brings the Rust MCP surface to feature parity with openclaw / hermes for the user-editable policy and standing-search workflows. Prior to this version, Rust hosts could not customize negotiation policies or persist per-search strategy across sessions — the embedded skill bundle covered the canonical (read-only) skill but skipped the operator-edited surfaces. The whole "your agent, your rules" durable-boundary contract now works the same on Claude Code (openclaw) and on the Rust hosts.

### Added

- **klodi-{zeroclaw,moltis,ironclaw}: three new MCP tools** that close the parity gap with openclaw / hermes:
  - `klodi_setup_reseed_policies` — non-destructive seed of `${KLODI_HOME}/policies/{negotiation_style,security}.md` from the embedded skill bundle. Existing files are preserved verbatim; the agent calls this to restore a deleted policy file without touching the user's edits to the others.
  - `klodi_watch` — composite tool. `persist=true` registers a server-side standing search via `p2p.v1.searches.create` AND writes `${KLODI_HOME}/buy/<slug>.md` with frontmatter (query, max_price, target_price, delivery, action_on_match) so the agent reads the user's strategy when `search.match` wakes arrive. `persist=false` is a one-shot equivalent of `klodi_search`.
  - `klodi_unwatch` — composite tool. Calls `p2p.v1.searches.delete` and removes the buy file. Idempotent on missing files.
- **`klodi_setup_status` is now actually actionable.** New phase `needs_policy` between `registering` and `ready`, driven by file presence + `negotiation_style.md` placeholder detection. New issue codes: `not_registered`, `partial_credentials`, `negotiation_style_missing`, `negotiation_style_unfilled`, `security_policy_missing`. New structured `next_action: { kind, message, … }` field where `kind` is `cli` (run a host-specific binary), `tool` (call another klodi MCP tool), `shell` (chmod-style command surfaced for the user to run), or `dialog` (prompt the user to fill a template). Per-host CLI name (`klodi-ironclaw-register` / `klodi-moltis-register` / `klodi-zeroclaw-register`) substitutes into the messages so the agent surfaces the right command for the current host.
- **klodi-{zeroclaw,moltis,ironclaw}-register: policy seeding on first registration.** After persisting `nats.creds` + `config.json`, the register binary now calls `klodi_rust_host::policy_seed::seed_policies_if_absent` to write `policies/{negotiation_style,security}.md` from the embedded skill bundle. Non-destructive — re-runs preserve every operator edit. Failures here are logged but don't block registration (creds are already on disk; the next `klodi_setup_status` surfaces the missing policy via `negotiation_style_missing` / `security_policy_missing`).
- **`${KLODI_HOME}` layout symmetry with TS / Py hosts.** New on-disk subtrees: `policies/` (user-editable), `buy/<slug>.md` (written by `klodi_watch`), `sell/<slug>.md` (written by listing-lifecycle hooks). Path helpers added to `klodi_rust_host::paths` (`policies_dir`, `buy_dir`, `sell_dir`, `negotiation_style_path`, `security_policy_path`, `buy_file_path`, `sell_file_path`).

### Changed

- **klodi-rust-host:** `mcp::skill_data` promoted to top-level `skill_bundle` module so the `include_dir!`-embedded canonical skill bundle is reachable from the registration flow (which is not gated behind the `mcp` feature). `include_dir` becomes a non-optional dep; `mcp` feature now gates only `rmcp` + `toml_edit`.
- **klodi-rust-host:** `SetupStatus` shape extended with `negotiation_style_seeded`, `negotiation_style_filled`, `security_policy_seeded`, `issues[]` (typed structs replacing the prior flat `issue_codes` strings — the legacy `issue_codes` field is preserved for back-compat), and `next_action: Option<NextAction>`. Phase enum gains a new `needs_policy` variant. `klodi_setup_status_with_register_cli(klodi_home, cli_name)` exposed for adapter binaries to substitute their host-specific register CLI name into the generated messages; the existing `klodi_setup_status(klodi_home)` defaults the name to `klodi-register`.
- **klodi-{zeroclaw,moltis,ironclaw}-mcp:** `McpConfig` gains a `register_cli: String` field so the host-specific binary name flows into `dispatch_setup_status`. Adapter `mcp.rs` binaries set it explicitly (`klodi-ironclaw-register`, `klodi-moltis-register`, `klodi-zeroclaw-register`).
- **`klodi_setup_status` description** in `tools/list` no longer references `klodi_register` (which is not on the Rust MCP surface). Replaced with a description that points at the structured `next_action` field for recovery directives.
- **Spec § 6 (Skill delivery path)** for ironclaw / moltis / zeroclaw: clarifies the split between the embedded canonical skill (`klodi://skill/<rel-path>`, read-only, no drift) and the on-disk user-editable policy files (`${KLODI_HOME}/policies/`, seeded once non-destructively from the same bundle). Spec § 7 (Local-state files) adds the new `policies/`, `buy/<slug>.md`, `sell/<slug>.md` entries with file-mode + ownership notes.
- **Rust adapter READMEs** (ironclaw / moltis / zeroclaw): new "Files in `${KLODI_HOME}`" and "Repair / bad credentials" sections. Documents the re-run-the-register-binary recovery flow that was previously buried in spec § 5.

## [0.2.1] — 2026-05-06

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

### Added

- **klodi-{zeroclaw,moltis,ironclaw}:** new `klodi-<host>-mcp` binary per Rust adapter — a stdio Model Context Protocol server that exposes the full klodi tool catalog (every `klodi_*` request/reply tool from `packages/tool-catalog/dist/schemas.json` plus the local `klodi_setup_status`, `klodi_health`, `klodi_channel_message`) and the canonical skill bundle (`klodi-plugin/skill/`) to the host's agent. The host spawns the binary on demand per agent session per its `[[mcp.servers]]` config; the agent reads each skill file via MCP `resources/read` under `klodi://skill/<rel-path>`. This closes the in-agent tool-surface gap from the 0.2.0 multi-host build plan, where the Rust adapters shipped only the wake forwarder and the agent had no way to call `klodi_list_create`, respond to offers, or send channel messages without operator intervention. Implementation lives in shared `klodi_rust_host::mcp` so all three adapters reuse one body — only the bin wrapper and the host config path differ per host.
- **klodi-<host>-register** (zeroclaw / moltis / ironclaw) now writes the `[[mcp.servers]]` block into the host's `config.toml` at the end of registration:
  - `klodi-zeroclaw-register` → `~/.zeroclaw/config.toml` (or `$ZEROCLAW_CONFIG`)
  - `klodi-moltis-register` → `~/.moltis/config.toml` (or `$MOLTIS_CONFIG`)
  - `klodi-ironclaw-register` → `~/.ironclaw/config.toml` (or `$IRONCLAW_CONFIG`)

  Each is idempotent — re-running after an upgrade replaces the `klodi` entry only and preserves any unrelated server blocks. The new behavior is on by default; pass `--skip-<host>-config` for hosts that only forward wakes and don't run the agent locally.
- **Skill bundle delivery via MCP resources.** Each published Rust adapter crate now embeds `klodi-plugin/skill/` at compile time via `include_dir!` and serves each file under `klodi://skill/<rel-path>`. Single source of truth — no on-disk seeding step, no operator-edited drift, no `klodi_setup_reseed_skill` analogue needed on these hosts.

### Changed

- **klodi-rust-host:** new `mcp` Cargo feature gates the MCP server module (`klodi_rust_host::mcp`) and the host config writer (`klodi_rust_host::host_mcp_config` — the latter formerly `zeroclaw_config`, generalised to take the host-name string). Daemon-only adapters (any future host that doesn't expose an MCP client) keep their lean dependency tree by leaving the feature off. Pulled-in deps under the gate: `rmcp = "1.6"` (server + transport-io + macros), `include_dir = "0.7"`, `toml_edit = "0.22"`. `chrono` workspace pin nudged from `=0.4.38` to `=0.4.39` to satisfy `schemars 1.x`'s `chrono04` integration (no behavioural change).
- **adapters/{zeroclaw,moltis,ironclaw}/scripts/vendor.py:**
  - Recursively copies vendored crate sources (`rglob("*.rs")` instead of top-level `glob`) so `klodi_rust_host::mcp::*` files reach the staged tree.
  - Copies `tool-catalog/dist/schemas.json` to `<staged>/src/schemas.json` and the workspace `skill/` bundle to `<staged>/skill/` so the embedded-resource macros (`include_str!`, `include_dir!`) expand inside the published crate.
  - Strips `#[cfg(feature = "mcp")]` gates from vendored sources and drops `optional = true` from injected MCP deps — each published Rust adapter crate has no opt-out, so the gates and the parallel `[features]` table they would otherwise require are unnecessary.
  - Rewrites `crate::` references to `crate::_<mod>::` so vendored sub-modules at any depth (e.g. `_rust_host/mcp/tools.rs`) resolve siblings via the adapter library root.

### Migrating from 0.1.x to 0.2.0

If you are running OpenClaw with `@4gpts/klodi@0.1.x`, the 0.2.0 jump retires several runtime concepts. **You do not need to do anything special** — the upgrade is install-and-go — but the following will look different:

**1. Wake events arrive automatically; `klodi_pending` is gone.** In 0.1.x the agent had to call `klodi_pending` periodically to drain queued wakes. In 0.2.0 the plugin holds a persistent NATS-WebSocket connection per session and JetStream pushes events directly to your agent's wake handler. If your agent's SOUL/system-prompt told it to call `klodi_pending`, remove that instruction — the tool no longer exists. See `klodi-plugin/skill/SKILL.md` Section 3 for the new wake delivery model.

**2. `klodi_channel_send` renamed to `klodi_channel_message`.** The channel-send path no longer goes through request/reply — `klodi_channel_message` publishes directly to the JetStream channel subject and the marketplace's side-consumer persists it. The agent-facing call shape is the same: `klodi_channel_message({ channel_id, content })`. If your SOUL references the old name, update it.

**3. Webhook plane retired.** The `klodi_wake_register` tool, the `wake.hmac` credential, the `services/wake-fanout/` fanout, the `klodi-mcp` Node binary, and OpenClaw-specific files (`webhook.ts`, `webhook-route.ts`, `wake-register.ts`, `tools/pending.ts`, `lib/duration.ts`, `lib/api-config.ts`, `heartbeatIssues()`) are all deleted. If you wrote any glue depending on these surfaces, it must move to the JetStream-based plumbing — typically zero code, since the plugin handles delivery.

**4. Heartbeat config no longer required.** The `agents.defaults.heartbeat.target "last"` directive from 0.1.1 is no longer needed (heartbeat config check removed; see ADR-0007 superseded note). You can safely remove the directive from your OpenClaw config; the plugin works either way.

**5. Setup phases trimmed.** The OpenClaw setup phase enum is now `unregistered | corrupt | degraded | needs_policy | ready`. The retired `needs_wake_registration` and `needs_heartbeat` phases will not appear. If you wrote scripts that checked for these phases, drop those branches.

**6. Multi-host support.** 0.2.0 introduces per-language adapters (`klodi-hermes` Python, `klodi-nanobot` Python, `klodi-moltis`/`klodi-ironclaw`/`klodi-zeroclaw` Rust). Each shares the catalog + NATS client packages but ships its own host integration. If you were OpenClaw-only, nothing changes; if you want to integrate Klodi into another host, see `klodi-plugin/docs/specs/hosts/`.

**7. Tool-name surface unchanged elsewhere.** Aside from `klodi_pending` and `klodi_channel_send`, every other `klodi_*` tool name is identical to 0.1.x. Catalog (`klodi-plugin/packages/tool-catalog/src/index.ts`) is the single source of truth.

### Supply chain

- **OpenClaw adapter packaging.** Vendoring of runtime deps into `dist/node_modules/` (per old [ADR-0003](docs/decisions/0003-vendored-runtime-dependencies.md)) is dropped. Workspace deps (`@klodi/tool-catalog`, `@klodi/nats-client`) now ride in via `bundleDependencies` (materialized by `scripts/pack-with-bundles.mjs`); public-registry transitives resolve via the host's `npm install --omit=dev --silent --ignore-scripts`. The install-time-code-execution guarantee from ADR-0003 is preserved by OpenClaw's `--ignore-scripts` enforcement (verified in `2026.4.15`) plus the plugin's `openclaw.install.minHostVersion: ">=2026.4.15"` pin. Single tarball shape eliminates the previous two-variant smoke (vendored vs. ClawHub-stripped). See new [ADR-0008](docs/decisions/0008-bundled-deps-host-ignore-scripts.md).
- **Hermes adapter:** `install.sh` now uses `pip install -r requirements.txt --require-hashes` when hash pins are present (regenerate via `pip-compile --generate-hashes` per `klodi-plugin/adapters/hermes/REQUIREMENTS.md`). Pre-launch the closure ships without hashes (klodi-nats-client is vendored, not on PyPI); `install.sh` falls back to a regular install in that mode and logs the downgrade. Per **R § P2-22**.
- **Pin audit policy** (per **R § P3-20**): run `pip-audit -r requirements.txt` before tagging any release. `nats-py==2.14.0` and `websockets==15.0` are the load-bearing pins; check them against current advisories. If `pip-audit` flags a CVE on either, the next release MUST bump the pin and re-audit.

## [0.2.2] — 2026-05-04

**Python adapters only.** OpenClaw and the Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are unaffected and not republished at this version.

### Fixed

- **klodi-hermes / klodi-nanobot:** the vendored `_klodi_*_natsclient/schemas.json` shipped in the 0.2.0 and 0.2.1 wheels was generated from a pre-`fulfillment` snapshot of `packages/tool-catalog/src/index.ts` — `klodi_list_create`, `klodi_list_update`, `klodi_search`, and `klodi_searches_create` advertised the retired flat triple (`delivery_method` / `location_area` / `ships_to`) instead of the discriminated-union `fulfillment` (listings) and `delivery` (searches). The marketplace had moved to the union shape, so every Python-adapter listing creation hit `INVALID_FULFILLMENT` from the server, while OpenClaw kept working because it imports the live TypeBox catalog (`@klodi/tool-catalog`) instead of a frozen JSON mirror. Root cause: `pnpm --filter @klodi/tool-catalog codegen` is not idempotent against TS source edits and was never re-run after the union migration. Wheels rebuilt with the fresh schema.

### Changed

- **Build hook (klodi-hermes, klodi-nanobot):** the adapter `Makefile`'s `vendor` target now depends on a new `codegen` target that invokes `pnpm --filter @klodi/tool-catalog codegen` from the repo root before `vendor.py` stages the vendored client. Codegen is idempotent and cheap; running it on every wheel build means a TS catalog edit can never silently ship a stale Python schema again. The check-codegen-fresh script under `packages/tool-catalog/scripts/` remains available as a separate guard for committed-mirror drift.

## [0.2.1] — 2026-05-04

**Python adapters only.** OpenClaw and the Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are unaffected and not republished at this version.

### Fixed

- **klodi-hermes:** wake handlers (`handle_notification` / `handle_channel_message`) ran the bridge ctx's synchronous `inject_message` — which shells out to `hermes chat --continue -Q` for up to 120s — directly on the asyncio loop. The blocking subprocess froze the second consumer's pull-fetch and the nats-py WebSocket heartbeat for the chat's duration, so the WS connection died past its heartbeat budget and the consumer silently stopped delivering subsequent wakes (offers, search matches, channel messages observed missing in production after the first wake landed). Inject is now dispatched off the loop via `asyncio.to_thread`; cross-thread serialization stays in `BridgeCtx._inject_lock`. `adapters/hermes/src/klodi_hermes/wake_handlers.py`.
- **klodi-nanobot:** same shape — `_on_notification` / `_on_channel` ran `_publish_to_event_bus` (which `subprocess.run`s `nanobot events publish`, 10s timeout) inline on the daemon's asyncio loop, blocking the same consumer pull-fetches and WS heartbeat. Lower observed blast radius than hermes (10s vs 120s, fast CLI), but the failure mode is identical when the CLI cold-starts or hangs. Now dispatched off-loop via `asyncio.to_thread`; the wake closures were extracted from `_run` into `_make_wake_callbacks(channel)` for direct testability. `adapters/nanobot/nanobot_daemon.py`.

## [0.2.0] — 2026-04-25

**NATS-native host plugins.** All adapters now hold a single persistent NATS-WebSocket connection per session for both tool calls and wakes. The webhook plane, the `klodi-mcp` Node binary, and host cron paths are retired.

### Removed

- `services/wake-fanout/` and `klodi-plugin/packages/klodi-mcp/`.
- OpenClaw: `webhook.ts`, `webhook-route.ts`, `wake-register.ts`, `tools/pending.ts`, `wake.hmac` credential, `klodi_wake_register` tool, `needs_wake_registration` setup phase, `needs_heartbeat` setup phase, `lib/duration.ts`, `lib/api-config.ts`, `heartbeatIssues()`.
- Hermes, nanobot, Moltis, IronClaw, ZeroClaw: never shipped the retired pieces.

### Added

- `klodi-plugin/packages/tool-catalog/` — canonical `klodi_*` tool surface, codegen produces `dist/schemas.json` (Python consumer) and `dist/rust-types.rs` (Rust consumer).
- `klodi-plugin/packages/nats-client-{ts,py,rs}/` — one persistent NATS-WS connection per session.
- Hermes / nanobot skill bundling at `${klodi_home}/skill/` via `copy_skill.py` + `seed_skill_dir`.
- Per-host adapter spec at `klodi-plugin/docs/specs/hosts/` (`_template.md`, `openclaw.md`, `hermes.md`, `nanobot.md`).
- Cross-language golden corpus at `klodi-plugin/packages/tool-catalog/tests/golden/` consumed by TS / Py / Rs contract tests.

### Changed

- Wake event payloads now carry full content; the agent wakes with the message body in hand. No separate drain step.
- `klodi_channel_send` replaced by direct JetStream publish via `client.publish_channel_message(channel_id, body)`.
- `klodi_watch persist=true` now registers server-side; matches arrive as `search.match` notifications. No host cron required.
- OpenClaw `wake.ts` rethrows on heartbeat API error → JetStream redelivery is the retry mechanism (per `max_deliver: 5` / `ack_wait: 30s`).
- OpenClaw setup phase enum trimmed to `unregistered | corrupt | degraded | needs_policy | ready`. Klodi no longer inspects host wake-primitive config; if wakes are not landing, consult the host's own routing config (see adapter README).

## [0.1.14] — 2026-04-23

(OpenClaw only — pre-consolidation history retained verbatim from the prior `klodi-plugin/adapters/openclaw/CHANGELOG.md`. Other adapters did not exist or were not yet versioned.)

### Changed

- **Positioning rewritten across README, manifest, package, and skill.** The "Facebook Marketplace for OpenClaw agents" framing was being parsed as "a plugin that manages Facebook Marketplace listings" rather than "a new marketplace built for agents." All user- and LLM-facing descriptions now lead with *"The marketplace where agents buy and sell stuff for you"* and position klodi as the standalone next-generation successor to Facebook Marketplace, Craigslist, OfferUp, and Etsy — not a wrapper on any existing platform.

## [0.1.13] — 2026-04-22

### Added

- `SECURITY.md` at the OpenClaw adapter root (now consolidated to repo level in 0.2.0).
- `contracts.tools` in `openclaw.plugin.json`. Declares all 32 `klodi_*` tool names statically.
- `activation.onCapabilities: ["tool"]` hint in the manifest.

### Changed

- Entry-point header docstring (`src/index.ts`) expanded to document the service, the single outbound host, credential paths and modes, and the private-content boundary.
- README gains a "We take your agent's security seriously" section.
- Build no longer emits `.d.ts` or `.js.map` files from plugin source.

## [0.1.12] — 2026-04-22

### Fixed

- **ClawHub installs of `@4gpts/klodi` no longer fail with `Cannot find module '@nats-io/jetstream'`.** Moved seven runtime packages from `devDependencies` to `dependencies`. The build-time vendoring in `vendor-deps.mjs` carries them into `dist/node_modules/` for direct-tarball installs; ClawHub strips that path during ingestion.

### Smoke

- `scripts/smoke-plugin-load.sh` now runs a second install variant that deletes `package/dist/node_modules/` from the packed tarball before install, simulating the ClawHub ingestion path.

## [0.1.11] — 2026-04-22

### Changed

- Plugin display name in `openclaw.plugin.json` is now `klodi` (was `Klodi Marketplace`).
- Brand-style lowercase `klodi` applied across all user-facing text.
- No change to npm package name, plugin id, tool names, on-disk paths, config schema, or notification payload contents.

## [0.1.10] — 2026-04-21

### Fixed

- **NATS WebSocket now routes through the `ws` package instead of `globalThis.WebSocket`.** Root cause (diagnosed via same-process A/B test inside an OpenClaw gateway): Node 24 ships undici 7.21 as its internal HTTP client; undici 7.21 offers `h2` via ALPN for WebSocket upgrades; Railway's Fastly edge picks `h2` and then rejects the RFC 8441 Extended CONNECT upgrade. Plugin now vendors `ws@8.18.0`.

### Hardening

- Explicit 10-second connect timeout on `wsconnect`.
- `bootstrap()` now logs `error_name`, `error_message`, `error_cause`, `error_stack`, and `server` on `nats_connect_failed`.

## [0.1.9] — 2026-04-21

### Fixed

- `klodi_health` now actively retries the NATS bootstrap instead of only reading cached connection state.

## [0.1.8] — 2026-04-20

### Changed

- **NATS transport swapped from raw TCP to WebSocket.** The plugin now connects with `wss://klodi-net.4gpts.com` instead of `nats://autorack.proxy.rlwy.net:41212`.
- **Client library migrated from the legacy `nats@2.29.3` package to the actively-maintained `@nats-io/*` family.**
- Requires **Node 22+** on the OpenClaw host for the native `WebSocket` global.

### Operational

- Client-side `pingInterval: 20s` mirrors the server's new `ping_interval: "20s"`.

## [0.1.7] — 2026-04-20

### Added

- `klodi_unwatch` tool. Removes a standing search by `buy_slug`.
- `sell_file` / `buy_file` side-effect metadata in tool responses.

## [0.1.6] — 2026-04-20

### Fixed

- Agent wakes were LOST on every notification — two compounding root causes in `service/wake.ts`:
  1. Wrong `enqueueSystemEvent` signature.
  2. `requestHeartbeatNow` reason landed in kind="other".

### Added

- `wake_enqueued` info log fires on successful enqueue with `{ reason, sessionKey }`.

## [0.1.5] — 2026-04-20

### Fixed

- `wake_failed` logs were undiagnosable: a single try/catch around `enqueueSystemEvent` + `requestHeartbeatNow` collapsed two semantically different failures into one line. Each call now has its own try/catch.

## [0.1.4] — 2026-04-19

### Fixed

- Registration and notification wakes could stall for up to 30 minutes after a user signed up. (Heartbeat-config check was added here; removed in 0.2.0 — see ADR-0007 superseded note.)
- Two of the five agent-wake call sites had no try/catch. All five sites now route through a single `wakeAgent(api, text, reason)` helper.

### Changed

- Log keys `onboarding_prompt_failed` and `register_wake_failed` consolidated into a single `wake_failed` event.

## [0.1.3] — 2026-04-19

### Fixed

- `plugins.klodi.config.klodi_api_url` and `plugins.klodi.config.klodi_home` were silently ignored. Plugin entry now reads from `api.pluginConfig` (schema-validated, plugin-scoped block).

### Added

- `klodi_setup_status` JSON now includes `api_url_source` and `klodi_home_source`.

## [0.1.2] — 2026-04-18

### Fixed

- Plugin load failed with `Cannot find module 'nats'` after `openclaw plugins install @4gpts/klodi`. Tarball now vendors NATS deps into `dist/node_modules/` at build time.

### Changed

- `openclaw.plugin.json` now tracks `package.json`'s version.

## [0.1.1] — 2026-04-18

### Fixed

- `klodi_setup_status` and `skill/SETUP.md` now instruct users to run `openclaw config set agents.defaults.heartbeat.target "last"` (later removed in 0.2.0).

## [0.1.0] — 2026-04-17

First publishable release of the OpenClaw adapter.
