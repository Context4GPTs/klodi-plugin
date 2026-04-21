/**
 * Tests for src/tools/setup.ts — klodi_setup_status and klodi_setup_repair.
 *
 * Uses the real filesystem via createTempHome() so phase derivation
 * runs against actual path checks. NATS is mocked; api.config and
 * api.pluginConfig are seeded as plain object trees matching the
 * production OpenClawConfig shape (no fictional .get() method).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  createMockPluginApi,
  getTool,
  type MockPluginAPI,
} from '../helpers/mock-plugin-api.js'
import { createTempHome, type TempHome } from '../helpers/temp-home.js'

vi.mock('../../lib/nats-client.js', () => ({
  isConnected: vi.fn(() => true),
  request: vi.fn(),
  getConnection: vi.fn(),
  drain: vi.fn(),
  WHOAMI_PROBE_TIMEOUT_MS: 3_000,
}))

vi.mock('../../service/nats.js', () => ({
  resetNatsState: vi.fn().mockResolvedValue(undefined),
  registerNatsService: vi.fn(),
}))

import { isConnected, request } from '../../lib/nats-client.js'
import { resetNatsState } from '../../service/nats.js'
import { registerSetupTools } from '../../tools/setup.js'
import {
  startRegisterPoll,
  stopRegisterPoll,
} from '../../tools/register-poller.js'
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
  getCredsPath,
  getConfigPath,
  getNegotiationStylePath,
  getSecurityPolicyPath,
} from '../../lib/config.js'

const mockIsConnected = vi.mocked(isConnected)
const mockRequest = vi.mocked(request)
const mockResetNatsState = vi.mocked(resetNatsState)

let api: MockPluginAPI
let home: TempHome

const VALID_CONFIG = {
  handle: 'testuser',
  user_id: 'uid-123',
  nkey_public: 'NKEY',
  nats_url: 'nats://localhost:4222',
}

/** Write creds+config so the setup sees a registered user. */
function writeValidRegistration(): void {
  writeFileSync(getCredsPath(), 'CREDS_CONTENT', 'utf-8')
  chmodSync(getCredsPath(), 0o600)
  writeFileSync(
    getConfigPath(),
    JSON.stringify(VALID_CONFIG),
    'utf-8',
  )
}

/** Write a fully-filled negotiation style (no placeholders). */
function writeFilledPolicy(): void {
  writeFileSync(
    getNegotiationStylePath(),
    '# Negotiation Style\n\n## Posture\n\nfirm\n\n'
      + '## Logistics Preferences\n\n- Areas: Brooklyn\n',
    'utf-8',
  )
}

/**
 * Seed an OpenClaw config tree with the given heartbeat target + every.
 * Production reads these paths via readApiConfig(api, 'agents.defaults.heartbeat.*')
 * which walks the plain object — NO `.get()` method exists on `api.config`.
 *
 * Default `every` = "1m" — a valid cadence well under the 120_000 ms (2
 * minute) ceiling setup-state enforces. Pass `null` to OMIT the key so
 * tests can verify the "missing every" rejection path.
 */
function configWithHeartbeat(
  target: string,
  every: string | null = '1m',
): Record<string, unknown> {
  const heartbeat: Record<string, unknown> = { target }
  if (every !== null) heartbeat.every = every
  return {
    agents: { defaults: { heartbeat } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  home = createTempHome()
  // Happy-path default: heartbeat = "last". Individual tests that
  // need a different heartbeat (or plugin-scoped config) rebuild
  // the api locally and re-register tools against it.
  api = createMockPluginApi({ config: configWithHeartbeat('last') })
  registerSetupTools(api)

  // Happy-path defaults — individual tests override as needed.
  mockIsConnected.mockReturnValue(true)
  mockRequest.mockResolvedValue({ handle: 'testuser' })
})

afterEach(() => {
  stopRegisterPoll('test_cleanup')
  home.cleanup()
})

// ── klodi_setup_status ─────────────────────────────────────────────────────

describe('klodi_setup_status', () => {
  it('phase=unregistered on a fresh install with no creds', async () => {
    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('unregistered')
    expect(data.checks.credentials_present).toBe(false)
    expect(data.checks.config_present).toBe(false)
    expect(data.config.nats_url).toBeNull()
    expect(data.issues[0].code).toBe('not_registered')
    expect(data.issues[0].fix.tool).toBe('klodi_register')
  })

  it('phase=corrupt when creds exist but config does not', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('corrupt')
    expect(data.issues[0].code).toBe('partial_credentials')
    expect(data.issues[0].fix.tool).toBe('klodi_setup_repair')
  })

  it('phase=corrupt when config is missing required fields', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ handle: 'only' }),
      'utf-8',
    )

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('corrupt')
    expect(data.issues[0].code).toBe('invalid_config')
  })

  it('phase=degraded when NATS disconnected', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()
    mockIsConnected.mockReturnValue(false)

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('degraded')
    expect(data.checks.nats_connected).toBe(false)
    expect(data.checks.nats_whoami_ok).toBeNull()
    expect(data.issues.map((i: { code: string }) => i.code))
      .toContain('nats_disconnected')
  })

  it('phase=degraded when whoami probe fails despite connection', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()
    mockRequest.mockResolvedValueOnce({
      error: 'unauthorized',
      message: 'invalid creds',
    })

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('degraded')
    expect(data.checks.nats_whoami_ok).toBe(false)
    expect(data.issues.map((i: { code: string }) => i.code))
      .toContain('whoami_failed')
  })

  it('phase=needs_heartbeat when heartbeat.target is not "last"', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()
    // Rebuild the api with heartbeat.target='none' and re-register so
    // the tool closure captures the new config tree.
    api = createMockPluginApi({ config: configWithHeartbeat('none') })
    registerSetupTools(api)

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('needs_heartbeat')
    const issue = data.issues.find(
      (i: { code: string }) => i.code === 'heartbeat_not_last',
    )
    expect(issue).toBeDefined()
    expect(issue.fix.kind).toBe('shell')
    expect(issue.fix.shell).toContain(
      'openclaw config set agents.defaults.heartbeat.target "last"',
    )
  })

  it(
    'emits heartbeat_interval_too_long issue when heartbeat.every ' +
      'is absent from the config tree',
    async () => {
      writeValidRegistration()
      seedNegotiationStyleIfAbsent()
      seedSecurityPolicyIfAbsent()
      writeFilledPolicy()
      // Target is correct; `every` is omitted entirely. Pass null
      // to the helper to drop the key from the config object.
      api = createMockPluginApi({
        config: configWithHeartbeat('last', null),
      })
      registerSetupTools(api)

      const tool = getTool(api, 'klodi_setup_status')
      const result = await tool.execute('call-1', {})

      const data = JSON.parse(result.content[0].text!)
      const issue = data.issues.find(
        (i: { code: string }) => i.code === 'heartbeat_interval_too_long',
      )
      expect(issue).toBeDefined()
      expect(issue.severity).toBe('error')
      expect(issue.fix.kind).toBe('shell')
      expect(issue.fix.shell).toContain(
        'openclaw config set agents.defaults.heartbeat.every',
      )
      // The shell command must suggest a valid value the user can
      // copy/paste without thinking — 1m or 2m are the only
      // reasonable choices under the 2-minute ceiling.
      expect(issue.fix.shell).toMatch(/"(1m|2m)"/)
    },
  )

  it(
    'emits heartbeat_interval_too_long issue when heartbeat.every="0m" ' +
      '(zero cadence is unusable)',
    async () => {
      writeValidRegistration()
      seedNegotiationStyleIfAbsent()
      seedSecurityPolicyIfAbsent()
      writeFilledPolicy()
      api = createMockPluginApi({
        config: configWithHeartbeat('last', '0m'),
      })
      registerSetupTools(api)

      const tool = getTool(api, 'klodi_setup_status')
      const result = await tool.execute('call-1', {})

      const data = JSON.parse(result.content[0].text!)
      const issue = data.issues.find(
        (i: { code: string }) => i.code === 'heartbeat_interval_too_long',
      )
      expect(issue).toBeDefined()
      expect(issue.severity).toBe('error')
      expect(issue.fix.kind).toBe('shell')
      expect(issue.fix.shell).toContain(
        'openclaw config set agents.defaults.heartbeat.every',
      )
    },
  )

  it(
    'emits heartbeat_interval_too_long issue when heartbeat.every="30m" ' +
      '(the OpenClaw default exceeds the 2-minute ceiling)',
    async () => {
      writeValidRegistration()
      seedNegotiationStyleIfAbsent()
      seedSecurityPolicyIfAbsent()
      writeFilledPolicy()
      // "30m" = 1_800_000 ms — the OpenClaw out-of-the-box default.
      // The plugin cannot accept this because queued wakes would
      // stall up to 30 minutes when requestHeartbeatNow no-ops.
      api = createMockPluginApi({
        config: configWithHeartbeat('last', '30m'),
      })
      registerSetupTools(api)

      const tool = getTool(api, 'klodi_setup_status')
      const result = await tool.execute('call-1', {})

      const data = JSON.parse(result.content[0].text!)
      const issue = data.issues.find(
        (i: { code: string }) => i.code === 'heartbeat_interval_too_long',
      )
      expect(issue).toBeDefined()
      expect(issue.severity).toBe('error')
      expect(issue.fix.kind).toBe('shell')
    },
  )

  it(
    'does NOT emit heartbeat_interval_too_long when heartbeat.every ' +
      'is valid (negative case — "1m" is within the 2-minute ceiling)',
    async () => {
      writeValidRegistration()
      seedNegotiationStyleIfAbsent()
      seedSecurityPolicyIfAbsent()
      writeFilledPolicy()
      // Default helper value "1m" = 60_000 ms — well within bounds.
      api = createMockPluginApi({
        config: configWithHeartbeat('last', '1m'),
      })
      registerSetupTools(api)

      const tool = getTool(api, 'klodi_setup_status')
      const result = await tool.execute('call-1', {})

      const data = JSON.parse(result.content[0].text!)
      const issue = data.issues.find(
        (i: { code: string }) => i.code === 'heartbeat_interval_too_long',
      )
      expect(issue).toBeUndefined()
    },
  )

  it('phase=needs_policy when negotiation_style is seeded but unfilled', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()   // leaves placeholders
    seedSecurityPolicyIfAbsent()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('needs_policy')
    const issue = data.issues.find(
      (i: { code: string }) => i.code === 'policy_unfilled',
    )
    expect(issue).toBeDefined()
    expect(issue.fix.kind).toBe('dialog')
  })

  it('phase=needs_policy when security.md is missing (points at non-destructive reseed)', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    writeFilledPolicy()
    // Deliberately skip seedSecurityPolicyIfAbsent

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('needs_policy')
    const issue = data.issues.find(
      (i: { code: string }) => i.code === 'policy_files_missing',
    )
    expect(issue).toBeDefined()
    // MUST NOT point at the destructive klodi_setup_repair tool.
    expect(issue.fix.tool).toBe('klodi_setup_reseed_policies')
    expect(issue.fix.tool).not.toBe('klodi_setup_repair')
  })

  it('partial_credentials message names which file is missing', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    const issue = data.issues.find(
      (i: { code: string }) => i.code === 'partial_credentials',
    )
    expect(issue.message).toContain('nats.creds present')
    expect(issue.message).toContain('config.json missing')
  })

  it('phase=ready when everything is green', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.phase).toBe('ready')
    expect(data.issues).toEqual([])
    expect(data.checks.nats_connected).toBe(true)
    expect(data.checks.nats_whoami_ok).toBe(true)
    expect(data.checks.policy_filled).toBe(true)
    expect(data.checks.security_policy_present).toBe(true)
    expect(data.next_step).toMatch(/delete setup\.md/i)
  })

  it('includes a creds_perms warning when nats.creds is not mode 600', async () => {
    writeValidRegistration()
    chmodSync(getCredsPath(), 0o644)
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    const warn = data.issues.find(
      (i: { code: string }) => i.code === 'creds_perms',
    )
    expect(warn).toBeDefined()
    expect(warn.severity).toBe('warn')
    expect(warn.fix.shell).toContain('chmod 600')
  })

  it('resolves klodi_home via setKlodiHome, not hardcoded path', async () => {
    writeValidRegistration()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.config.klodi_home).toBe(home.path)
  })
})

// ── config_source surfacing ────────────────────────────────────────────────
//
// klodi_setup_status exposes where each config value came from so the
// user can debug "I set plugins.klodi.config.klodi_api_url to X but
// the plugin is still hitting Y". Contract:
//
//   config.api_url_source      "config" | "env" | "default"
//   config.klodi_home_source   "config" | "env" | "default"
//
// Sources in precedence order:
//   - "config": value was set via `api.pluginConfig.klodi_api_url` /
//               `api.pluginConfig.klodi_home` at registration time.
//   - "env":    value came from the KLODI_API_URL / KLODI_HOME env var.
//   - "default": neither config nor env was set — hardcoded fallback.

describe('klodi_setup_status: config_source', () => {
  /**
   * Clear both layers of state before each test:
   *   1. module-level _apiUrl set by a prior test's setApiUrl() call
   *   2. the KLODI_API_URL env var
   * so each test sees a clean precedence chain (pluginConfig → env → default).
   */
  let savedApiUrlEnv: string | undefined

  beforeEach(async () => {
    const { setApiUrl } = await import('../../lib/config.js')
    setApiUrl('')
    savedApiUrlEnv = process.env['KLODI_API_URL']
    delete process.env['KLODI_API_URL']
  })

  afterEach(() => {
    if (savedApiUrlEnv === undefined) {
      delete process.env['KLODI_API_URL']
    } else {
      process.env['KLODI_API_URL'] = savedApiUrlEnv
    }
  })

  it('reports api_url_source="config" when pluginConfig.klodi_api_url is set', async () => {
    // Rebuild api with plugin-scoped api url override + heartbeat OK.
    api = createMockPluginApi({
      config: configWithHeartbeat('last'),
      pluginConfig: { klodi_api_url: 'http://host.docker.internal:3000' },
    })
    registerSetupTools(api)
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.config.api_url).toBe('http://host.docker.internal:3000')
    expect(data.config.api_url_source).toBe('config')
  })

  it('reports api_url_source="env" when only the env var is set', async () => {
    process.env['KLODI_API_URL'] = 'https://env.klodi.example.com'

    api = createMockPluginApi({
      config: configWithHeartbeat('last'),
      pluginConfig: {},
    })
    registerSetupTools(api)
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.config.api_url).toBe('https://env.klodi.example.com')
    expect(data.config.api_url_source).toBe('env')
  })

  it('reports api_url_source="default" when neither pluginConfig nor env is set', async () => {
    // beforeEach already deleted KLODI_API_URL and cleared _apiUrl.
    api = createMockPluginApi({
      config: configWithHeartbeat('last'),
      pluginConfig: {},
    })
    registerSetupTools(api)
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    writeFilledPolicy()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.config.api_url_source).toBe('default')
  })

  it('reports klodi_home_source="config" when pluginConfig.klodi_home is set', async () => {
    // Note: createTempHome() already called setKlodiHome(home.path)
    // as if it were a pluginConfig override — for the test we explicitly
    // surface that this was from the config source.
    api = createMockPluginApi({
      config: configWithHeartbeat('last'),
      pluginConfig: { klodi_home: home.path },
    })
    registerSetupTools(api)
    writeValidRegistration()

    const tool = getTool(api, 'klodi_setup_status')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.config.klodi_home).toBe(home.path)
    expect(data.config.klodi_home_source).toBe('config')
  })
})

// ── klodi_setup_repair ─────────────────────────────────────────────────────

describe('klodi_setup_repair', () => {
  it('removes nats.creds and config.json when present', async () => {
    writeValidRegistration()
    // Also seed policies to prove they are NOT removed.
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()

    const tool = getTool(api, 'klodi_setup_repair')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.removed).toContain(getCredsPath())
    expect(data.removed).toContain(getConfigPath())

    expect(existsSync(getCredsPath())).toBe(false)
    expect(existsSync(getConfigPath())).toBe(false)

    // Policies survived the repair.
    expect(existsSync(getNegotiationStylePath())).toBe(true)
  })

  it('calls resetNatsState before unlinking so in-flight consumers drain first', async () => {
    writeValidRegistration()

    const callOrder: string[] = []
    mockResetNatsState.mockImplementationOnce(async () => {
      callOrder.push('resetNatsState')
      // Confirm files still exist when reset runs — ordering proof.
      expect(existsSync(getCredsPath())).toBe(true)
    })

    const tool = getTool(api, 'klodi_setup_repair')
    await tool.execute('call-1', {})

    expect(mockResetNatsState).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['resetNatsState'])
    expect(existsSync(getCredsPath())).toBe(false)
  })

  it('clears cachedConfig so subsequent loadConfig re-reads disk', async () => {
    writeValidRegistration()

    // Warm the cache via a status probe first.
    const status = getTool(api, 'klodi_setup_status')
    const priorResult = await status.execute('call-1', {})
    const priorData = JSON.parse(priorResult.content[0].text!)
    expect(priorData.config.nats_url).toBe(VALID_CONFIG.nats_url)

    // Repair and confirm config is now unreadable (cache cleared).
    const repair = getTool(api, 'klodi_setup_repair')
    await repair.execute('call-1', {})

    const postResult = await status.execute('call-2', {})
    const postData = JSON.parse(postResult.content[0].text!)
    expect(postData.config.nats_url).toBeNull()
    expect(postData.phase).toBe('unregistered')
  })

  it('logs setup_repaired at warn level with the prior user_id for on-call trail', async () => {
    writeValidRegistration()

    const tool = getTool(api, 'klodi_setup_repair')
    await tool.execute('call-1', {})

    expect(api.logger.warn).toHaveBeenCalledWith(
      'setup_repaired',
      expect.objectContaining({
        prior_user_id: VALID_CONFIG.user_id,
        removed: expect.arrayContaining([getCredsPath()]),
      }),
    )
  })

  it('never touches sell, buy, or policies directories', async () => {
    writeValidRegistration()
    seedNegotiationStyleIfAbsent()
    seedSecurityPolicyIfAbsent()
    const sellFile = join(home.sellDir, 'my-item.md')
    const buyFile = join(home.buyDir, 'keyboard-hunt.md')
    writeFileSync(sellFile, '---\nlisting_id: abc\n---\n', 'utf-8')
    writeFileSync(buyFile, '---\nquery: keys\n---\n', 'utf-8')

    const tool = getTool(api, 'klodi_setup_repair')
    await tool.execute('call-1', {})

    expect(existsSync(sellFile)).toBe(true)
    expect(existsSync(buyFile)).toBe(true)
    expect(existsSync(getNegotiationStylePath())).toBe(true)
    expect(existsSync(getSecurityPolicyPath())).toBe(true)
  })

  it('is a no-op when creds/config are already absent', async () => {
    const tool = getTool(api, 'klodi_setup_repair')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.removed).toEqual([])
    expect(data.failures).toEqual([])
    // Still resets module state — cheap insurance.
    expect(mockResetNatsState).toHaveBeenCalledTimes(1)
  })

  it('returns an error result when unlinkSync fails (hard failure)', async () => {
    writeValidRegistration()

    // Make the creds file unremovable by dropping write permission
    // on the containing directory. On POSIX, that causes unlinkSync
    // to throw EACCES even though the file itself is writable.
    // Restore in finally so test cleanup can delete the temp home.
    chmodSync(home.path, 0o500)

    try {
      const tool = getTool(api, 'klodi_setup_repair')
      const result = await tool.execute('call-1', {})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Repair incomplete')
      expect(api.logger.error).toHaveBeenCalledWith(
        'setup_repair_failed',
        expect.objectContaining({
          failures: expect.arrayContaining([
            expect.objectContaining({
              path: expect.any(String),
              error: expect.stringContaining('EACCES'),
            }),
          ]),
        }),
      )
    } finally {
      chmodSync(home.path, 0o700)
    }
  })

  it('removes creds-only when config is missing (partial repair)', async () => {
    mkdirSync(home.path, { recursive: true })
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')

    const tool = getTool(api, 'klodi_setup_repair')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.removed).toEqual([getCredsPath()])
    expect(existsSync(getCredsPath())).toBe(false)
  })

  it('cancels any in-flight register poll so it stops fetching', async () => {
    vi.useFakeTimers()
    try {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'pending' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      startRegisterPoll(api, '550e8400-e29b-41d4-a716-446655440000')
      // Confirm the poll is live — one tick fires a fetch.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const tool = getTool(api, 'klodi_setup_repair')
      await tool.execute('call-1', {})

      // After repair, the interval is gone — further ticks silent.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

// ── klodi_setup_reseed_policies ────────────────────────────────────────────

describe('klodi_setup_reseed_policies', () => {
  it('seeds both files when absent', async () => {
    expect(existsSync(getNegotiationStylePath())).toBe(false)
    expect(existsSync(getSecurityPolicyPath())).toBe(false)

    const tool = getTool(api, 'klodi_setup_reseed_policies')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.negotiation_style_seeded).toBe(true)
    expect(data.security_policy_seeded).toBe(true)
    expect(existsSync(getNegotiationStylePath())).toBe(true)
    expect(existsSync(getSecurityPolicyPath())).toBe(true)
  })

  it('does not overwrite a user-customized negotiation_style.md', async () => {
    const custom = '# Custom policy\n\ndo not overwrite me\n'
    // Ensure policies dir exists before writing
    mkdirSync(home.policiesDir, { recursive: true })
    writeFileSync(getNegotiationStylePath(), custom, 'utf-8')

    const tool = getTool(api, 'klodi_setup_reseed_policies')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.negotiation_style_seeded).toBe(false)

    // User content preserved verbatim.
    const onDisk = readFileSync(getNegotiationStylePath(), 'utf-8')
    expect(onDisk).toBe(custom)
  })

  it('never touches credentials or config', async () => {
    writeValidRegistration()

    const tool = getTool(api, 'klodi_setup_reseed_policies')
    await tool.execute('call-1', {})

    expect(existsSync(getCredsPath())).toBe(true)
    expect(existsSync(getConfigPath())).toBe(true)
  })
})
