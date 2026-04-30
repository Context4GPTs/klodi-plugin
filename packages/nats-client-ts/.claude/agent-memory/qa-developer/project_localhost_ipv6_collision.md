---
name: localhost ws://localhost:8080 collides with Fellou.app on this machine
description: On the founder's macOS dev box, Fellou.app squats on [::1]:8080 — IPv6-resolved localhost lands on it instead of NATS, breaking integration tests that default to ws://localhost:8080
type: project
---

When running `@klodi/nats-client` integration tests on Ioannis's Mac, `ws://localhost:8080` resolves to IPv6 `[::1]:8080` first, where `Fellou.app` (a desktop app) is also listening. The TLS-less WebSocket upgrade is rejected with HTTP 404, surfaced as `ConnectionError: Unexpected server response: 404`.

NATS itself is reachable on `127.0.0.1:8080` (IPv4) and the Docker port mapping is correct (`*:8080`).

**Why:** macOS's `getaddrinfo` returns IPv6 first for `localhost`, and Docker Desktop's port proxy listens on `*:8080` (matches v4 + v6) but a separately-installed app (Fellou) is also bound to `[::1]:8080`, taking precedence on the IPv6 path.

**How to apply:** When running these integration suites locally, set `TEST_NATS_WS_URL=ws://127.0.0.1:8080` to force IPv4 and bypass the collision:

```
INTEGRATION=1 TEST_NATS_WS_URL=ws://127.0.0.1:8080 pnpm --filter @klodi/nats-client test
```

Do not change the default URL in test code — `ws://localhost:8080` is correct on machines without the squatter. The env hook (`process.env["TEST_NATS_WS_URL"]`) is already exposed in `tests/integration/client.integration.test.ts` and `tests/integration/reconnect-drain.integration.test.ts`.

Same workaround likely needed for `@klodi/marketplace` integration tests if/when they run locally on the same host. If you see "Unexpected server response: 404" against any NATS WS URL on this machine, suspect IPv6 collision before suspecting the test or implementation.
