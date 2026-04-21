/**
 * Read a config value from the plugin API across SDK shapes.
 *
 * Older OpenClaw releases expose `api.config.get(key)`; newer ones expose
 * `api.config` as a plain object tree (so a key like "heartbeat.target"
 * walks `config.heartbeat.target`, and "agents.defaults.heartbeat.target"
 * walks nested). This helper keeps the plugin functional during the
 * transition without leaking `any` or try/catch noise into call sites.
 */
import type { PluginAPI } from "openclaw/plugin-sdk";

export function readApiConfig(api: PluginAPI, key: string): unknown {
  const maybeGet = (api.config as { get?: (k: string) => unknown } | undefined)?.get;
  if (typeof maybeGet === "function") {
    return maybeGet.call(api.config, key);
  }
  let cur: unknown = api.config;
  for (const part of key.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
