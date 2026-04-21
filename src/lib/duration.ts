/**
 * Parse an OpenClaw heartbeat cadence string like "30m", "5s", "1h",
 * or a bare integer (default unit = minutes per OpenClaw docs).
 *
 * Used by setup-state and nats bootstrap to validate
 * agents.defaults.heartbeat.every. The OpenClaw default is "30m";
 * when requestHeartbeatNow silently no-ops (SDK #29215/#34338/#14191),
 * queued wakes stall up to that interval. We need a strict parser to
 * fail setup early when the cadence is missing or absurdly long.
 *
 * Returns null for anything we can't interpret unambiguously, so
 * callers can distinguish "not configured" from "zero duration".
 */

/**
 * Inclusive upper bound for `agents.defaults.heartbeat.every`. Any
 * parsed value above this is rejected by setup-state and nats
 * bootstrap. Lives here (next to the parser) rather than in
 * setup-state because two unrelated modules consume it and pulling
 * it from `lib/` keeps the dependency direction `service` → `lib`.
 */
export const HEARTBEAT_EVERY_CEILING_MS = 120_000;

const DURATION_RE = /^(\d+)(s|m|h)?$/;

export function parseDurationMs(input: unknown): number | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const match = DURATION_RE.exec(trimmed);
  if (match === null) return null;

  const value = Number(match[1]);
  const unit = match[2] ?? "m";

  switch (unit) {
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
  }

  return null;
}
