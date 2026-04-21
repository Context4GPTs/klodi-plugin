/**
 * Tests for src/lib/setup-state.ts — heartbeat.every validation.
 *
 * The plugin relies on OpenClaw's internal heartbeat cadence to wake
 * the agent between user turns; `agents.defaults.heartbeat.every`
 * defaults to "30m" in OpenClaw. When requestHeartbeatNow silently
 * no-ops (SDK #29215/#34338/#14191), queued wakes stall for up to that
 * interval — unacceptable for a marketplace where seconds matter.
 *
 * Contract under test:
 *   - SetupChecks gains `heartbeat_every_ms: number | null` (null when
 *     the config key is absent OR the value cannot be parsed).
 *   - gatherChecks reads `agents.defaults.heartbeat.every` via
 *     parseDurationMs and sets heartbeat_every_ms accordingly.
 *   - derivePhase returns "needs_heartbeat" when heartbeat_every_ms is
 *     null / 0 / greater than 120_000 (2 minutes). The boundary value
 *     of exactly 120_000 is accepted. This gate is checked AFTER the
 *     existing `heartbeat_target !== "last"` gate so the target
 *     precedence is preserved (a wrong target still reads as
 *     needs_heartbeat for the target reason).
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  createMockPluginApi,
  type MockPluginAPI,
} from '../helpers/mock-plugin-api.js'
import { createTempHome, type TempHome } from '../helpers/temp-home.js'

// Boundary mocks: nats-client is an I/O boundary. Business logic under
// test (derivePhase + gatherChecks config walk) stays unmocked.
vi.mock('../../lib/nats-client.js', () => ({
  isConnected: vi.fn(() => false),
  request: vi.fn(),
  getConnection: vi.fn(),
  drain: vi.fn(),
  WHOAMI_PROBE_TIMEOUT_MS: 3_000,
}))

import {
  derivePhase,
  gatherChecks,
  type SetupChecks,
} from '../../lib/setup-state.js'
import {
  getCredsPath,
  getConfigPath,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
  getNegotiationStylePath,
} from '../../lib/config.js'

// 2 minutes — the maximum heartbeat cadence the plugin accepts. Longer
// than this and queued wakes stall too long when requestHeartbeatNow
// no-ops (SDK #29215/#34338/#14191).
const MAX_HEARTBEAT_EVERY_MS = 120_000

const VALID_CONFIG = {
  handle: 'testuser',
  user_id: 'uid-123',
  nkey_public: 'NKEY',
  nats_url: 'nats://localhost:4222',
}

/**
 * Build a fully-green SetupChecks object. Individual tests override
 * the field under test. Seeding every field (not Partial<...>) means
 * adding a new SetupChecks field forces a compile error here — no
 * silent drift between production contract and test fixtures.
 */
function greenChecks(overrides: Partial<SetupChecks> = {}): SetupChecks {
  const base: SetupChecks = {
    credentials_present: true,
    config_present: true,
    config_valid: true,
    creds_mode_600: true,
    nats_connected: true,
    nats_whoami_ok: true,
    heartbeat_target: 'last',
    // 1 minute — safe default well under the 2-minute ceiling.
    heartbeat_every_ms: 60_000,
    policy_seeded: true,
    policy_filled: true,
    security_policy_present: true,
  }
  return { ...base, ...overrides }
}

// ── derivePhase: heartbeat_every_ms validation ─────────────────────────────

describe('derivePhase heartbeat_every_ms validation', () => {
  it(
    'returns "needs_heartbeat" when heartbeat_every_ms is null ' +
      '(config key missing)',
    () => {
      // Arrange
      const checks = greenChecks({ heartbeat_every_ms: null })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('needs_heartbeat')
    },
  )

  it(
    'returns "needs_heartbeat" when heartbeat_every_ms is 0 ' +
      '(disabled via "0m")',
    () => {
      // Arrange — user explicitly set "0m" which parseDurationMs maps
      // to 0; zero is not a usable cadence.
      const checks = greenChecks({ heartbeat_every_ms: 0 })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('needs_heartbeat')
    },
  )

  it(
    'returns "needs_heartbeat" when heartbeat_every_ms exceeds the ' +
      '120_000 ms (2 minute) ceiling (OpenClaw default is 30m = 1_800_000)',
    () => {
      // Arrange — OpenClaw default "30m" parses to 1_800_000 ms.
      const checks = greenChecks({ heartbeat_every_ms: 1_800_000 })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('needs_heartbeat')
    },
  )

  it(
    'returns "ready" when heartbeat_every_ms equals exactly ' +
      '120_000 ms (the boundary is inclusive)',
    () => {
      // Arrange — boundary case: "2m" = 120_000 ms is the longest
      // acceptable cadence.
      const checks = greenChecks({
        heartbeat_every_ms: MAX_HEARTBEAT_EVERY_MS,
      })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('ready')
    },
  )

  it(
    'returns "ready" when heartbeat_every_ms is 60_000 ms ' +
      '(1 minute — normal case)',
    () => {
      // Arrange
      const checks = greenChecks({ heartbeat_every_ms: 60_000 })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('ready')
    },
  )

  it(
    'preserves heartbeat_target precedence: wrong target with bad ' +
      'every still reads as needs_heartbeat (target gate wins)',
    () => {
      // Arrange — both gates fail; the phase must still be
      // needs_heartbeat (not e.g. "ready"). This proves the every
      // check is AFTER the target check, not a replacement.
      const checks = greenChecks({
        heartbeat_target: 'none',
        heartbeat_every_ms: null,
      })

      // Act
      const phase = derivePhase(checks)

      // Assert
      expect(phase).toBe('needs_heartbeat')
    },
  )
})

// ── gatherChecks: heartbeat_every_ms population ────────────────────────────

describe('gatherChecks heartbeat_every_ms population', () => {
  let api: MockPluginAPI
  let home: TempHome

  beforeEach(() => {
    vi.clearAllMocks()
    home = createTempHome()
    // Seed creds + config + policies so the non-heartbeat fields
    // don't derail gatherChecks. Tests in this block only care
    // about heartbeat_every_ms population.
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')
    writeFileSync(getConfigPath(), JSON.stringify(VALID_CONFIG), 'utf-8')
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    // Fill the negotiation style so policy_filled is true
    writeFileSync(
      getNegotiationStylePath(),
      '# Negotiation Style\n\n## Posture\n\nfirm\n',
      'utf-8',
    )
  })

  afterEach(() => {
    home.cleanup()
  })

  it(
    'parses heartbeat.every="30s" into heartbeat_every_ms=30_000 ' +
      '(valid cadence string)',
    async () => {
      // Arrange
      api = createMockPluginApi({
        config: {
          agents: { defaults: { heartbeat: { target: 'last', every: '30s' } } },
        },
      })

      // Act — probe: false to skip the NATS round-trip (cheap path).
      const checks = await gatherChecks(api, { probe: false })

      // Assert
      // 30 seconds × 1000 ms = 30_000
      expect(checks.heartbeat_every_ms).toBe(30_000)
    },
  )

  it(
    'sets heartbeat_every_ms=null when heartbeat.every is garbage ' +
      '(parseDurationMs rejects unparseable input)',
    async () => {
      // Arrange
      api = createMockPluginApi({
        config: {
          agents: {
            defaults: { heartbeat: { target: 'last', every: 'garbage' } },
          },
        },
      })

      // Act
      const checks = await gatherChecks(api, { probe: false })

      // Assert
      expect(checks.heartbeat_every_ms).toBeNull()
    },
  )

  it(
    'sets heartbeat_every_ms=null when agents.defaults.heartbeat.every ' +
      'is absent from the config tree',
    async () => {
      // Arrange — only target present, no every key.
      api = createMockPluginApi({
        config: {
          agents: { defaults: { heartbeat: { target: 'last' } } },
        },
      })

      // Act
      const checks = await gatherChecks(api, { probe: false })

      // Assert — missing is distinguishable from "0"; both result in
      // null from the walker point of view for a missing key
      // (parseDurationMs(undefined) → null).
      expect(checks.heartbeat_every_ms).toBeNull()
    },
  )
})
