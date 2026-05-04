# klodi-nats-client (Python)

Python port of the TypeScript `@klodi/nats-client`. Used by the Hermes
and nanobot host adapters.

The wire is identical to the TS client. Tool calls go over NATS
request/reply with `X-User-Id` + `X-Nkey-Public` headers; wakes are
durable JetStream consumers; channel messages are direct JetStream
publishes.

The tool subjects and JSON Schemas come from
`klodi-plugin/packages/tool-catalog/dist/schemas.json` — bundled into
the package at build time.
