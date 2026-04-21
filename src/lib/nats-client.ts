/**
 * Shared NATS connection for the Klodi plugin.
 * Used by both tools (request-reply) and the JetStream consumer (notifications).
 *
 * Connects over WebSocket (`wss://` in production, `ws://` locally) using the
 * `@nats-io/nats-core` client with an explicit `ws`-backed `wsFactory`.
 *
 * Why not `globalThis.WebSocket`:
 *   1. Node 24 ships undici 7.21 as its internal copy; `globalThis.WebSocket`
 *      uses it.
 *   2. undici 7.21 offers both `h2` and `http/1.1` via ALPN for WebSocket
 *      upgrades. Fastly (Railway's edge) picks `h2`.
 *   3. undici 7.21 then tries WebSocket via RFC 8441 Extended CONNECT. Fastly
 *      does not send `SETTINGS_ENABLE_CONNECT_PROTOCOL` and rejects it —
 *      surfaced as a bare `ConnectionError` with no message.
 *   4. undici 8.x fixes this by defaulting `allowH2: false` for WebSocket, but
 *      Node's internal copy isn't upgradable from userland.
 *   5. `ws` sidesteps undici entirely and does the HTTP/1.1 upgrade via
 *      `node:tls`, which Fastly handles correctly.
 */

import {
  wsconnect,
  credsAuthenticator,
  headers as natsHeaders,
  type NatsConnection,
  type Msg,
} from "@nats-io/nats-core";
import { WebSocket as NodeWebSocket } from "ws";
import { loadConfig, loadCreds } from "./config.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Shared timeout for setup-phase and health-probe whoami calls. */
export const WHOAMI_PROBE_TIMEOUT_MS = 3_000;

/**
 * Mirrors the server-side `ping_interval: "20s"` in infra/nats/nats-server.conf.
 * Keeps idle WS connections alive behind Railway's HTTP/WS edge, which closes
 * idle sockets more aggressively than NATS's 2-minute default.
 */
const WS_PING_INTERVAL_MS = 20_000;

/**
 * Tighter than nats-core's 20s default: a broken handshake should surface
 * fast enough that `klodi_health`'s retry path is useful, and
 * `ensureNatsRunning` doesn't stall startup for 20s on each failed boot.
 */
const WS_CONNECT_TIMEOUT_MS = 10_000;

let connection: NatsConnection | null = null;
let connectingPromise: Promise<NatsConnection> | null = null;

export interface NatsRequestOptions {
  timeout?: number;
}

/** Get or create the shared NATS connection. */
export async function getConnection(): Promise<NatsConnection> {
  if (connection && !connection.isClosed()) return connection;
  if (connectingPromise) return connectingPromise;

  connectingPromise = doConnect();
  try {
    connection = await connectingPromise;
    return connection;
  } finally {
    connectingPromise = null;
  }
}

async function doConnect(): Promise<NatsConnection> {
  const config = loadConfig();
  const creds = loadCreds();

  const nc = await wsconnect({
    servers: config.nats_url,
    authenticator: credsAuthenticator(creds),
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    reconnectJitter: 1_000,
    pingInterval: WS_PING_INTERVAL_MS,
    timeout: WS_CONNECT_TIMEOUT_MS,
    // `ws` is W3C-compatible for the surface nats-core's WsTransport touches
    // (binaryType, onopen/onmessage/onclose/onerror, send, close,
    // bufferedAmount). The cast papers over TS lib.dom's WebSocket vs ws's
    // slightly narrower type — behavior is identical at runtime.
    wsFactory: (url: string) => Promise.resolve({
      socket: new NodeWebSocket(url) as unknown as WebSocket,
      encrypted: url.startsWith("wss://"),
    }),
  });

  return nc;
}

/** Send a NATS request-reply message and return the parsed JSON response. */
export async function request<T = Record<string, unknown>>(
  subject: string,
  payload: Record<string, unknown>,
  options?: NatsRequestOptions,
): Promise<T> {
  const nc = await getConnection();
  const config = loadConfig();

  const hdrs = natsHeaders();
  hdrs.set("X-User-Id", config.user_id);
  hdrs.set("X-Nkey-Public", config.nkey_public);

  const msg: Msg = await nc.request(
    subject,
    encoder.encode(JSON.stringify(payload)),
    {
      timeout: options?.timeout ?? 10_000,
      headers: hdrs,
    },
  );

  return JSON.parse(decoder.decode(msg.data)) as T;
}

/** Check if the NATS connection is alive. */
export function isConnected(): boolean {
  return connection !== null && !connection.isClosed();
}

/** Drain and close the NATS connection. */
export async function drain(): Promise<void> {
  if (connection) {
    await connection.drain();
    connection = null;
  }
}
