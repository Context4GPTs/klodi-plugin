/**
 * OpenClaw Plugin SDK type declarations.
 * These types are provided by the OpenClaw runtime — not an npm dependency.
 * See: https://docs.openclaw.ai/plugins/sdk-overview
 */

declare module "openclaw/plugin-sdk" {
  import type { TObject } from "@sinclair/typebox";

  export interface PluginAPI {
    registerTool(tool: ToolDefinition): void;
    registerService(service: ServiceDefinition): void;
    runtime: RuntimeAPI;
    logger: PluginLogger;
    /**
     * The full OpenClawConfig tree (plain object). Top-level keys
     * like `agents`, `plugins`, etc. are walked by dot-path. Not
     * plugin-scoped — do NOT read plugin-specific settings from
     * here; use `pluginConfig` instead.
     *
     * `unknown` is deliberate: the SDK does not model every key,
     * so callers must narrow via `readApiConfig` or typeof checks.
     */
    config: Record<string, unknown>;
    /**
     * Plugin-scoped config populated from the user's
     * `plugins.<id>.config.*` block. Validated at load time against
     * this plugin's `configSchema` in `openclaw.plugin.json`. Absent
     * when the user never wrote a scoped block. Always the correct
     * source for plugin-specific overrides.
     */
    pluginConfig?: Record<string, unknown>;
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: TObject;
    execute(
      callId: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult>;
  }

  export interface ToolResult {
    content: ToolContent[];
    isError?: boolean;
  }

  export interface ToolContent {
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }

  export interface ServiceDefinition {
    id: string;
    start(): Promise<void>;
    stop(): Promise<void>;
  }

  export interface RuntimeAPI {
    system: SystemAPI;
  }

  export interface SystemAPI {
    /**
     * Push a system event onto an agent session's queue. `sessionKey`
     * is required — the SDK throws `"system events require a
     * sessionKey"` when it's missing or empty, which routes the wake
     * to LOST. Build the canonical default-agent key with
     * `resolveAgentSessionKey(api)` (see `service/wake.ts`).
     *
     * Returns a Promise in the plugin boundary for symmetry with the
     * async ergonomics; the underlying implementation is synchronous
     * (returns boolean) so awaiting a truthy/falsy value is harmless.
     */
    enqueueSystemEvent(
      text: string,
      options: SystemEventOptions,
    ): Promise<void>;
    /**
     * Schedule a heartbeat wake. All fields are optional, but passing
     * `sessionKey` targets the specific session that `enqueueSystemEvent`
     * populated — without it the heartbeat wakes broadly and the
     * queued event may not drain on the expected turn.
     */
    requestHeartbeatNow(options: HeartbeatOptions): void;
  }

  export interface SystemEventOptions {
    sessionKey: string;
    contextKey?: string;
    deliveryContext?: {
      channel?: string;
      to?: string;
      threadId?: string;
    };
    trusted?: boolean;
  }

  export interface HeartbeatOptions {
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    coalesceMs?: number;
  }

  export interface PluginLogger {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
    debug(message: string, data?: Record<string, unknown>): void;
  }

  export type PluginRegisterFn = (api: PluginAPI) => void | Promise<void>;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { PluginRegisterFn } from "openclaw/plugin-sdk";

  export interface PluginEntry {
    id: string;
    name: string;
    description: string;
    register: PluginRegisterFn;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
