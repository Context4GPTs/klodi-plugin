/**
 * Narrow plugin-API surface used across the plugin's call graph.
 *
 * The full `PluginAPI` type from `openclaw/plugin-sdk` couples to a
 * specific SDK version and would force every helper to import from a
 * runtime-only module. `PluginAPILike` captures every field the plugin
 * actually touches downstream — logger, lifecycle bus, agent config,
 * runtime wake plumbing — so any helper that needs them can accept
 * this interface without coupling to the SDK or relying on `as never`
 * casts.
 *
 * Per **R § P2-11** + **D § Cluster I/IV**: the prior code accepted the
 * full `PluginAPI` everywhere and cast `api as never` at three sites in
 * the gateway lifecycle wiring (every cast hid a real structural
 * mismatch). Migrating helpers to `PluginAPILike` removes the casts AND
 * documents the actual surface the plugin depends on.
 *
 * Optional fields (`lifecycle?.on?`) reflect the SDK boundary — older
 * gateways may not expose the lifecycle bus, in which case the plugin
 * no-ops cleanly and tools still work via lazy connect on first use.
 */

export interface PluginLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface PluginLifecycleBus {
  on?: (event: string, handler: () => void) => void;
}

export interface PluginRuntimeSystem {
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string },
  ): Promise<void>;
  requestHeartbeatNow(options: { reason?: string; sessionKey?: string }): void;
}

export interface PluginRuntime {
  system: PluginRuntimeSystem;
}

export interface PluginAPILike {
  logger: PluginLogger;
  lifecycle?: PluginLifecycleBus;
  /** Full OpenClawConfig tree; walked by dot-path. Untyped per SDK. */
  config: Record<string, unknown>;
  runtime: PluginRuntime;
}
