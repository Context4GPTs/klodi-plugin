/**
 * Public surface of @klodi/nats-client.
 *
 * Adapters import from this single entry. The catalog (subjects,
 * params, results, event types) is re-exported from
 * @klodi/tool-catalog directly — no rewrap, no surface here.
 */

export {
  KlodiClient,
  KlodiRequestError,
  WHOAMI_PROBE_TIMEOUT_MS,
  assertEncryptedOrLocalhost,
  isLocalhost,
  type KlodiClientArgs,
  type RequestOptions,
} from "./client.js";

export {
  CaTrustError,
  natsCaPath,
  persistNatsCa,
  resolveTlsCa,
  type ResolvedTlsCa,
} from "./tls.js";

export {
  ConfigInvalidError,
  ConfigNotFoundError,
  CredsNotFoundError,
  loadConfig,
  loadCreds,
  type KlodiConfig,
} from "./config.js";

export {
  KlodiSetupError,
} from "./consumers.js";

export type {
  ActiveSubscription,
  ChannelHandler,
  NotificationHandler,
} from "./consumers.js";

export {
  computeBackoffMs,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from "./backoff.js";

export type { ClientMetrics } from "./metrics.js";

export {
  __resetWakePumpRegistryForTests,
  createWakePump,
  type WakePump,
  type WakePumpClient,
  type WakePumpHandlers,
  type WakePumpHealth,
  type WakePumpOptions,
} from "./wake-pump.js";
