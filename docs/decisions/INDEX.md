# Decisions Index

Architecture decision records. See [`README.md`](./README.md) for the format and `.claude/skills/distillation/SKILL.md` for the search-before-write procedure.

Rows are sorted **newest `updated_at` first**.

## Index

| Doc | Title | Tags | Updated |
|---|---|---|---|
| [[0017-golden-corpus-cross-language-contract]] | Golden corpus is the cross-language wake-event contract (Decision 7) — fixtures mirror the publisher wire body, not the enriched event | golden, contract, drift, cross-language, events, codegen, nats, gate, fixtures | 2026-06-25 |
| [[0009-vendored-ts-workspace-deps]] | Workspace TS deps vendored into `dist/_vendor/` at publish time | publish, vendoring, typescript | 2026-06-23 |
| [[0014-tool-symmetry-axes]] | Three tool-symmetry axes — manifest↔registered, referenced⊆catalog, catalog↔registered-by-name | symmetry, drift, manifest, catalog, tools, openclaw, gate, contracts | 2026-06-23 |
| [[0016-wake-log-correlator-contract]] | wake_enqueued correlator — echo the producer's event_id, never mint one; contract codegen'd into 3 loggers but emitter-satisfied only in openclaw | logging, correlator, wake, observability, catalog, contracts, adapters, parity, openclaw | 2026-06-23 |
| [[0015-gateway-runtime-load-vs-armed-axis]] | Gateway runtime-load axis — loaded ≠ armed; detect the gateway by argv subcommand, not process.title | openclaw, wake-pump, gateway, runtime, detection, activation, axis, contracts | 2026-06-22 |
| [[0011-adapter-exception-envelope]] | Adapter exception envelope and pre-call guard contract | envelope, guards, error-handling, adapters, parity | 2026-06-19 |
| [[0013-match-feedback-trust-boundary]] | Match-feedback emit — action-not-label trust boundary, body-id validation | trust-boundary, feedback, flywheel, publish, adapters, catalog, nats | 2026-05-30 |
| [[0012-tool-request-payload-parity]] | Tool→service request-payload parity (raw catalog pass-through) | parity, payload, adapters, catalog, search, request-path | 2026-05-29 |
| [[0006-direct-to-storage-photo-uploads]] | Direct-to-storage photo uploads via signed URLs | uploads, r2, marketplace | 2026-05-23 |
| [[0010-zeroclaw-browser-pairing-shim]] | Browser-pairing helper for klodi-zeroclaw (auto-mint + loopback HTTP shim) | zeroclaw, pairing, auth | 2026-05-10 |
| [[0004-preserve-state-on-uninstall]] | Preserve `$klodi_home` on uninstall | uninstall, state, openclaw | 2026-05-04 |
| [[0008-bundled-deps-host-ignore-scripts]] | Runtime deps via `bundleDependencies` + host-enforced `--ignore-scripts` | publish, supply-chain, superseded | 2026-04-30 |
| [[0007-timer-cadence-clamp]] | Timer cadences with parse clamps and silent auto-reject | timers, validation, superseded | 2026-04-30 |
| [[0005-client-side-floor-price-enforcement]] | Floor-price enforcement client-side only | pricing, marketplace | 2026-04-30 |
| [[0003-vendored-runtime-dependencies]] | Runtime dependencies vendored into `dist/node_modules/` | publish, vendoring, superseded | 2026-04-30 |
| [[0002-on-disk-nkey-credentials]] | On-disk NKey credentials at mode 0600 | credentials, nkey, filesystem | 2026-04-30 |
| [[0001-persistent-websocket-connection]] | Persistent WebSocket connection (not polling) | nats, websocket, wake-events | 2026-04-30 |
