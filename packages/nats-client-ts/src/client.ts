/**
 * KlodiClient — single persistent NATS-WS connection per session.
 *
 * Public surface:
 *   - connect()                 open the WS connection (NKey auth)
 *   - request(subject, body)    NATS request/reply for tool calls
 *   - subscribeNotifications    durable JetStream consumer + handler
 *   - subscribeChannels         durable JetStream consumer + handler
 *   - publishChannelMessage     direct JetStream publish to a channel
 *   - close()                   drain + close
 *   - isConnected()             liveness for health checks
 *
 * The class owns the connection lifecycle and the two consumer
 * subscriptions. All other behavior (durable creation, dedup, pull
 * loop) lives in `consumers.ts` and `publish.ts`.
 *
 * Why WebSocket via the `ws` package — see ADR-0001 / the comment block
 * in adapters/openclaw/src/lib/nats-client.ts on `main`. Node 24's
 * built-in WebSocket goes through undici 7.21 which fails RFC 8441
 * Extended CONNECT against Fastly (Railway's edge). `ws` does the
 * HTTP/1.1 upgrade via `node:tls` and works.
 */

import {
  credsAuthenticator,
  headers as natsHeaders,
  wsconnect,
  type Msg,
  type NatsConnection,
} from "@nats-io/nats-core";
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { WebSocket as NodeWebSocket } from "ws";
import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";
import { computeBackoffMs } from "./backoff.js";
import { loadConfig, loadCreds, type KlodiConfig } from "./config.js";
import {
  subscribeChannels,
  subscribeNotifications,
  type ActiveSubscription,
} from "./consumers.js";
import { KlodiMetrics, type ClientMetrics } from "./metrics.js";
import { publishChannelMessage } from "./publish.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Default timeout on tool-call request/reply. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Setup-phase / health-probe whoami timeout. */
export const WHOAMI_PROBE_TIMEOUT_MS = 3_000;

/** Mirror server-side ping_interval in nats-server.conf. */
const WS_PING_INTERVAL_MS = 20_000;

/** Tighter than nats-core's 20s default — see seed comment. */
const WS_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Per **D § D10**: NATS connections require TLS (`wss://`) by default.
 * Plaintext (`ws://`) is only accepted when the host is localhost / 127.0.0.1
 * / 0.0.0.0 / *.localhost. There's no env opt-out — if a non-localhost host
 * needs plaintext, the deployment is misconfigured (terminate TLS at the edge).
 *
 * Defends against the compound attack: an attacker who controls the API
 * endpoint (DNS hijack) injects a plaintext `nats_url` into the registration
 * response; without this guard the client persists it, then connects in
 * plaintext to attacker-controlled infrastructure.
 */
export function isLocalhost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost"
      || host === "127.0.0.1"
      || host === "0.0.0.0"
      || host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function assertWssOrLocalhost(natsUrl: string): void {
  if (natsUrl.startsWith("wss://")) return;
  if (isLocalhost(natsUrl)) return;
  throw new Error(
    `KlodiClient: nats_url must use wss:// (got ${natsUrl}). `
    + "Plaintext ws:// is only allowed when the host resolves to localhost. "
    + "Re-register if creds came from a compromised source.",
  );
}

export interface KlodiClientArgs {
  /** Path to ${klodi_home}/nats.creds. */
  credsPath: string;
  /** Path to ${klodi_home}/config.json. */
  configPath: string;
  /** Optional error sink (logging hook). Defaults to console.error. */
  onError?: (err: unknown, context: Record<string, unknown>) => void;
}

export interface RequestOptions {
  /** ms; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeout?: number;
}

interface ParsedError {
  error: string;
  message?: string;
  details?: unknown;
}

/**
 * KlodiRequestError carries a structured server-side error envelope
 * (the marketplace returns `{ error, message }` for handler-level
 * validation failures). Adapters catch and surface it as a tool-result
 * error string.
 */
export class KlodiRequestError extends Error {
  public readonly code: string;
  public readonly details: unknown;
  constructor(envelope: ParsedError) {
    super(envelope.message ?? envelope.error);
    this.name = "KlodiRequestError";
    this.code = envelope.error;
    this.details = envelope.details;
  }
}

/** Public class — keep instance state minimal. */
export class KlodiClient {
  private readonly args: KlodiClientArgs;
  private nc: NatsConnection | null = null;
  private connecting: Promise<NatsConnection> | null = null;
  private config: KlodiConfig | null = null;
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private notificationsSub: ActiveSubscription | null = null;
  private channelsSub: ActiveSubscription | null = null;
  /**
   * Per-connect attempt counter for the exponential backoff handler.
   * Reset to 0 on successful connect so the next outage starts fresh.
   * Tracked here (not on the NatsConnection) because `wsconnect` calls
   * `reconnectDelayHandler` with no arguments — P2-5.
   */
  private reconnectAttempt = 0;
  private readonly metricsImpl = new KlodiMetrics();

  constructor(args: KlodiClientArgs) {
    this.args = args;
  }

  /**
   * Read-only snapshot of per-client counters — P2-27.
   *
   * Use cases: in-process operator dashboard, the Rust daemons'
   * `--health-port /metrics` endpoint, ad-hoc diagnostic prints. The
   * snapshot is consistent at the moment of the call but not monotonic
   * across snapshots — call again for a refreshed view.
   */
  get metrics(): ClientMetrics {
    return this.metricsImpl.snapshot();
  }

  /** Internal — exposed so `consumers.ts` can increment counters. */
  get _metricsImpl(): KlodiMetrics {
    return this.metricsImpl;
  }

  /**
   * Per **R § P2-26**: surface the per-consumer activity timestamps so
   * health probes can distinguish a quiet consumer from a wedged one.
   * Returns `null` until the consumer has been subscribed (no
   * `subscribeNotifications()` yet) or before the first event lands.
   */
  getNotificationsLastEventAt(): Date | null {
    return this.notificationsSub?.getLastEventAt() ?? null;
  }

  /**
   * Per-consumer `inactive_threshold` (ms) captured at subscribe time.
   * Returns `null` when the consumer hasn't been subscribed yet or the
   * server didn't include the field in the consumer info response.
   */
  getNotificationsInactiveThresholdMs(): number | null {
    return this.notificationsSub?.getInactiveThresholdMs() ?? null;
  }

  /**
   * Open the underlying NATS-WS connection. Idempotent: returns the
   * existing connection when called twice.
   */
  async connect(): Promise<void> {
    if (this.nc !== null && !this.nc.isClosed()) return;
    if (this.connecting !== null) {
      await this.connecting;
      return;
    }
    this.connecting = this.doConnect();
    try {
      this.nc = await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  isConnected(): boolean {
    return this.nc !== null && !this.nc.isClosed();
  }

  /**
   * Tool-call request/reply. Adds X-User-Id and X-Nkey-Public headers
   * the marketplace's auth.ts uses to resolve the caller. Throws
   * KlodiRequestError on `{ error, message }` envelopes; throws
   * the underlying error on transport/timeout.
   */
  async request<T = Record<string, unknown>>(
    subject: string,
    body: object,
    options?: RequestOptions,
  ): Promise<T> {
    const nc = await this.requireConnection();
    const config = this.requireConfig();

    const hdrs = natsHeaders();
    hdrs.set("X-User-Id", config.user_id);
    hdrs.set("X-Nkey-Public", config.nkey_public);

    const msg: Msg = await nc.request(
      subject,
      encoder.encode(JSON.stringify(body)),
      {
        timeout: options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
        headers: hdrs,
      },
    );

    const parsed = JSON.parse(decoder.decode(msg.data)) as
      | T
      | ParsedError;
    if (
      typeof parsed === "object"
      && parsed !== null
      && "error" in parsed
      && typeof (parsed as ParsedError).error === "string"
    ) {
      throw new KlodiRequestError(parsed as ParsedError);
    }
    return parsed as T;
  }

  /**
   * Attach a handler to the per-user notifications consumer.
   * Library creates the durable consumer if absent and starts a
   * background pull loop. Each delivered event is parsed, deduped on
   * event_id, and passed to the handler. Resolved → ack. Thrown → nak.
   *
   * Calling twice replaces the previous handler (the previous loop is
   * stopped first).
   */
  async subscribeNotifications(
    handler: (event: NotificationEvent) => Promise<void>,
  ): Promise<ActiveSubscription> {
    await this.requireConnection();
    const config = this.requireConfig();
    const js = await this.requireJetStream();
    const jsm = await this.requireJetStreamManager();

    if (this.notificationsSub !== null) {
      await this.notificationsSub.stop();
      this.notificationsSub = null;
    }

    this.notificationsSub = await subscribeNotifications({
      js,
      jsm,
      userId: config.user_id,
      metrics: this.metricsImpl,
      handler,
      onError: (err) => this.reportError(err, {
        consumer: `klodi-notifications-${config.user_id}`,
      }),
    });
    return this.notificationsSub;
  }

  /**
   * Attach a handler to the per-user channels consumer.
   * filter_subjects is server-managed by the marketplace — we never
   * set or mutate it. New channels appear as new subjects in the
   * stream of deliveries.
   */
  async subscribeChannels(
    handler: (event: ChannelMessageEvent) => Promise<void>,
  ): Promise<ActiveSubscription> {
    await this.requireConnection();
    const config = this.requireConfig();
    const js = await this.requireJetStream();
    const jsm = await this.requireJetStreamManager();

    if (this.channelsSub !== null) {
      await this.channelsSub.stop();
      this.channelsSub = null;
    }

    this.channelsSub = await subscribeChannels({
      js,
      jsm,
      userId: config.user_id,
      metrics: this.metricsImpl,
      handler,
      onError: (err) => this.reportError(err, {
        consumer: `klodi-channels-${config.user_id}`,
      }),
    });
    return this.channelsSub;
  }

  /**
   * Publish a channel message via direct JetStream publish. Returns the
   * stream sequence as a durability confirmation — the message is now
   * in P2P_CHANNELS storage and queued for the recipient's consumer.
   */
  async publishChannelMessage(
    channelId: string,
    body: { content: string },
  ): Promise<{ sequence: number }> {
    await this.requireConnection();
    const config = this.requireConfig();
    const js = await this.requireJetStream();
    const result = await publishChannelMessage({
      js,
      channelId,
      senderUserId: config.user_id,
      senderHandle: config.handle,
      content: body.content,
    });
    return { sequence: result.sequence };
  }

  /**
   * Stop both consumer loops and drain the connection. After close()
   * a fresh `connect()` re-establishes everything.
   */
  async close(): Promise<void> {
    if (this.notificationsSub !== null) {
      await this.notificationsSub.stop();
      this.notificationsSub = null;
    }
    if (this.channelsSub !== null) {
      await this.channelsSub.stop();
      this.channelsSub = null;
    }
    if (this.nc !== null) {
      await this.nc.drain();
      this.nc = null;
    }
    this.js = null;
    this.jsm = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async doConnect(): Promise<NatsConnection> {
    const config = this.loadConfigFromDisk();
    assertWssOrLocalhost(config.nats_url);
    const creds = loadCreds(this.args.credsPath);
    // P2-5: exponential backoff with jitter, base 250ms × 2 capped at
    // 60s ± 25%. The handler runs once per reconnect attempt; we
    // increment our local counter so successive failures grow the
    // delay. Reset happens in `watchStatus` on a successful
    // "reconnect" event.
    const delayHandler = (): number => {
      this.reconnectAttempt += 1;
      return computeBackoffMs(this.reconnectAttempt);
    };
    const nc = await wsconnect({
      servers: config.nats_url,
      authenticator: credsAuthenticator(creds),
      maxReconnectAttempts: -1,
      reconnectDelayHandler: delayHandler,
      pingInterval: WS_PING_INTERVAL_MS,
      timeout: WS_CONNECT_TIMEOUT_MS,
      // `ws` is W3C-compatible for the surface nats-core's WsTransport
      // touches. Cast through unknown — see seed file for the rationale.
      wsFactory: (url: string) => Promise.resolve({
        socket: new NodeWebSocket(url) as unknown as WebSocket,
        encrypted: url.startsWith("wss://"),
      }),
    });
    // Initial connect succeeded — clear any prior attempt count so the
    // next outage starts the backoff fresh.
    this.reconnectAttempt = 0;
    this.watchStatus(nc);
    return nc;
  }

  /**
   * Background loop: drain the connection's status stream and reset the
   * backoff counter every time the library reports a successful
   * `"reconnect"`. Without this, a long-recovered connection that
   * subsequently disconnects would jump straight back to the cap delay
   * instead of starting at the base.
   */
  private watchStatus(nc: NatsConnection): void {
    void (async () => {
      try {
        for await (const status of nc.status()) {
          if (status.type === "reconnect") {
            this.reconnectAttempt = 0;
          }
        }
      } catch (err) {
        this.reportError(err, { phase: "status_stream" });
      }
    })();
  }

  private loadConfigFromDisk(): KlodiConfig {
    if (this.config === null) {
      this.config = loadConfig(this.args.configPath);
    }
    return this.config;
  }

  private async requireConnection(): Promise<NatsConnection> {
    if (this.nc === null || this.nc.isClosed()) {
      await this.connect();
    }
    if (this.nc === null) {
      throw new Error("KlodiClient: connection unavailable after connect()");
    }
    return this.nc;
  }

  private requireConfig(): KlodiConfig {
    return this.loadConfigFromDisk();
  }

  private async requireJetStream(): Promise<JetStreamClient> {
    const nc = await this.requireConnection();
    if (this.js === null) this.js = jetstream(nc);
    return this.js;
  }

  private async requireJetStreamManager(): Promise<JetStreamManager> {
    const nc = await this.requireConnection();
    if (this.jsm === null) this.jsm = await jetstreamManager(nc);
    return this.jsm;
  }

  private reportError(err: unknown, context: Record<string, unknown>): void {
    if (this.args.onError) {
      this.args.onError(err, context);
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[klodi-nats-client] consumer_error", {
      error: err instanceof Error ? err.message : String(err),
      ...context,
    });
  }
}
