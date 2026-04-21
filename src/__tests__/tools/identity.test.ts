/**
 * Tests for src/tools/identity.ts
 * Tools: klodi_register, klodi_register_poll, klodi_whoami, klodi_health, klodi_ratings
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMockPluginApi, getTool, type MockPluginAPI } from '../helpers/mock-plugin-api.js'

// ── Mocks (hoisted before imports) ──────────────────────────────────────────

vi.mock('../../lib/nats-client.js', () => ({
  request: vi.fn(),
  getConnection: vi.fn(),
  isConnected: vi.fn(() => true),
  drain: vi.fn(),
  WHOAMI_PROBE_TIMEOUT_MS: 3_000,
}))

vi.mock('../../lib/config.js', () => ({
  hasCredentials: vi.fn(() => true),
  loadConfig: vi.fn(() => ({
    handle: 'testuser',
    user_id: 'test-user-id',
    nkey_public: 'NKEY123',
    nats_url: 'nats://localhost:4222',
  })),
  getKlodiHome: vi.fn(() => '/tmp/test-klodi'),
  getCredsPath: vi.fn(() => '/tmp/test-klodi/nats.creds'),
  getConfigPath: vi.fn(() => '/tmp/test-klodi/config.json'),
  getApiUrl: vi.fn(() => 'https://test.klodi.4gpts.com'),
  getSellDir: vi.fn(() => '/tmp/test-klodi/sell'),
  getBuyDir: vi.fn(() => '/tmp/test-klodi/buy'),
  setKlodiHome: vi.fn(),
  writeConfig: vi.fn(),
  loadCreds: vi.fn(() => new Uint8Array()),
  readSellFile: vi.fn(),
  writeSellFile: vi.fn(),
  deleteSellFile: vi.fn(),
  readBuyFile: vi.fn(),
  writeBuyFile: vi.fn(),
  deleteBuyFile: vi.fn(),
  findSellFileByListingId: vi.fn(),
  listSellSlugs: vi.fn(() => []),
  listBuySlugs: vi.fn(() => []),
  slugify: vi.fn((t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)),
  getPoliciesDir: vi.fn(() => '/tmp/test-klodi/policies'),
  seedNegotiationStyleIfAbsent: vi.fn(() => false),
  seedSecurityPolicyIfAbsent: vi.fn(() => false),
  getNegotiationStylePath: vi.fn(() => '/tmp/test-klodi/policies/negotiation_style.md'),
  getNegotiationStyleTemplatePath: vi.fn(() => '/tmp/test-klodi/skill/templates/negotiation_style.template.md'),
  getSecurityPolicyPath: vi.fn(() => '/tmp/test-klodi/policies/security.md'),
  getSecurityPolicyTemplatePath: vi.fn(() => '/tmp/test-klodi/skill/policies/security.md'),
  getBundledSkillDir: vi.fn(() => '/tmp/test-klodi/skill'),
  isNegotiationStyleFilled: vi.fn(() => true),
}))

vi.mock('../../service/nats.js', () => ({
  ensureNatsRunning: vi.fn().mockResolvedValue({ status: 'running' }),
  registerNatsService: vi.fn(),
  resetNatsState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}))

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { request, isConnected } from '../../lib/nats-client.js'
import {
  hasCredentials,
  writeConfig,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from '../../lib/config.js'
import { ensureNatsRunning, resetNatsState } from '../../service/nats.js'
import { existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { registerIdentityTools } from '../../tools/identity.js'
import { stopRegisterPoll } from '../../tools/register-poller.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)
const mockIsConnected = vi.mocked(isConnected)
const mockExistsSync = vi.mocked(existsSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockMkdirSync = vi.mocked(mkdirSync)
const mockChmodSync = vi.mocked(chmodSync)
const mockWriteConfig = vi.mocked(writeConfig)
const mockSeedNegotiationStyle = vi.mocked(seedNegotiationStyleIfAbsent)
const mockSeedSecurity = vi.mocked(seedSecurityPolicyIfAbsent)
const mockEnsureNats = vi.mocked(ensureNatsRunning)
const mockResetNatsState = vi.mocked(resetNatsState)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const FIXED_UUID = '550e8400-e29b-41d4-a716-446655440000'
const mockFetch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerIdentityTools(api)

  // Stable UUID for register
  vi.stubGlobal('crypto', { randomUUID: () => FIXED_UUID })
  vi.stubGlobal('fetch', mockFetch)

  // Restore defaults
  mockHasCreds.mockReturnValue(true)
  mockIsConnected.mockReturnValue(true)
  mockExistsSync.mockReturnValue(true)
  mockSeedNegotiationStyle.mockReturnValue(false)
  mockSeedSecurity.mockReturnValue(false)
  mockEnsureNats.mockResolvedValue({ status: 'running' })
})

afterEach(() => {
  // Prevent the background poll started by klodi_register from leaking
  // into subsequent tests.
  stopRegisterPoll('test_cleanup')
  vi.unstubAllGlobals()
})

// ── klodi_register ──────────────────────────────────────────────────────────

describe('klodi_register', () => {
  it('returns already_registered when credentials exist', async () => {
    mockHasCreds.mockReturnValueOnce(true)

    const tool = getTool(api, 'klodi_register')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('already_registered')
    expect(data.handle).toBe('testuser')
  })

  it('returns auth_url and session_id when no credentials', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_register')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('awaiting_browser')
    expect(data.session_id).toBe(FIXED_UUID)
    expect(data.auth_url).toBe(
      `https://test.klodi.4gpts.com/authorize?session=${FIXED_UUID}`,
    )
    expect(data.poll_url).toBe(
      `https://test.klodi.4gpts.com/api/sessions/${FIXED_UUID}`,
    )
  })

  it('starts a background poll when no credentials exist', async () => {
    vi.useFakeTimers()
    try {
      mockHasCreds.mockReturnValueOnce(false)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'pending' }),
      })

      const tool = getTool(api, 'klodi_register')
      await tool.execute('call-1', {})

      // No synchronous fetch — first poll happens 5s later.
      expect(mockFetch).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        `https://test.klodi.4gpts.com/api/sessions/${FIXED_UUID}`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT start a background poll when already registered', async () => {
    vi.useFakeTimers()
    try {
      mockHasCreds.mockReturnValueOnce(true)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'pending' }),
      })

      const tool = getTool(api, 'klodi_register')
      await tool.execute('call-1', {})

      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── klodi_register_poll ─────────────────────────────────────────────────────

describe('klodi_register_poll', () => {
  const completedResponse = {
    status: 'completed',
    handle: 'newuser',
    user_id: 'new-user-id',
    nkey_public: 'NKEY456',
    nats_url: 'nats://prod:4222',
    nats_creds: 'CREDS_CONTENT_HERE',
  }

  it('writes config and creds on completed session', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: FIXED_UUID,
    })

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('registered')
    expect(data.handle).toBe('newuser')

    // Verify file system side effects
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi', { recursive: true })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi/sell', { recursive: true })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi/buy', { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-klodi/nats.creds',
      'CREDS_CONTENT_HERE',
      { encoding: 'utf-8', mode: 0o600 },
    )
    expect(mockChmodSync).toHaveBeenCalledWith('/tmp/test-klodi/nats.creds', 0o600)
    expect(mockWriteConfig).toHaveBeenCalledWith({
      handle: 'newuser',
      user_id: 'new-user-id',
      nkey_public: 'NKEY456',
      nats_url: 'nats://prod:4222',
    })

    // Verify correct poll URL
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      `https://test.klodi.4gpts.com/api/sessions/${FIXED_UUID}`,
    )
  })

  it('seeds both negotiation_style and security policies', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })
    mockSeedNegotiationStyle.mockReturnValue(true)
    mockSeedSecurity.mockReturnValue(true)

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    const data = JSON.parse(result.content[0].text!)
    expect(mockSeedNegotiationStyle).toHaveBeenCalledTimes(1)
    expect(mockSeedSecurity).toHaveBeenCalledTimes(1)
    expect(data.negotiation_style_seeded).toBe(true)
    expect(data.security_policy_seeded).toBe(true)
  })

  it('calls ensureNatsRunning after writing credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })

    const callOrder: string[] = []
    mockWriteConfig.mockImplementationOnce(() => {
      callOrder.push('writeConfig')
    })
    mockEnsureNats.mockImplementationOnce(async () => {
      callOrder.push('ensureNatsRunning')
      return { status: 'running' }
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(callOrder).toEqual(['writeConfig', 'ensureNatsRunning'])
    const data = JSON.parse(result.content[0].text!)
    expect(data.nats_connected).toBe(true)
  })

  it('drains the stale NATS connection before rebooting on successful claim', async () => {
    // Regression: after OAuth completes, klodi_register_poll writes the NEW
    // creds + config, but the cached NATS connection still holds the OLD
    // creds. ensureNatsRunning short-circuits on `consuming && isConnected()`
    // (service/nats.ts:95) so without resetNatsState() in between, the plugin
    // keeps talking to NATS with stale credentials forever. The fix mirrors
    // the proven pattern from klodi_setup_repair.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })

    const callOrder: string[] = []
    mockWriteConfig.mockImplementationOnce(() => {
      callOrder.push('writeConfig')
    })
    mockResetNatsState.mockImplementationOnce(async () => {
      callOrder.push('resetNatsState')
    })
    mockEnsureNats.mockImplementationOnce(async () => {
      callOrder.push('ensureNatsRunning')
      return { status: 'running' }
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(result.isError).toBeFalsy()
    expect(mockResetNatsState).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual([
      'writeConfig',
      'resetNatsState',
      'ensureNatsRunning',
    ])
  })

  it('reports nats_connected: false when bootstrap fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })
    mockEnsureNats.mockResolvedValueOnce({
      status: 'failed',
      reason: 'ECONNREFUSED',
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('registered')
    expect(data.nats_connected).toBe(false)
    expect(data.nats_reason).toContain('ECONNREFUSED')
  })

  it('returns error on expired session', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'expired' }),
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: FIXED_UUID,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('expired')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns pending on incomplete session', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'pending' }),
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: FIXED_UUID,
    })

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('pending')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'))

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: FIXED_UUID,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Failed to poll registration')
    expect(result.content[0].text).toContain('Network unreachable')
  })

  it('returns error on HTTP non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json') },
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: FIXED_UUID,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('HTTP 500')
    expect(result.content[0].text).toContain('Internal Server Error')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns dedicated message when body.error is CREDENTIALS_ALREADY_CLAIMED (409)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        error: 'CREDENTIALS_ALREADY_CLAIMED',
        message: 'session already consumed',
      }),
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already claimed')
    expect(result.content[0].text).toContain('klodi_register')
    expect(result.content[0].text).not.toContain('HTTP 409')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('falls back to HTTP status when non-2xx body is not CREDENTIALS_ALREADY_CLAIMED', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'SOMETHING_ELSE' }),
    })

    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('HTTP 500')
    expect(result.content[0].text).toContain('Internal Server Error')
  })

  it('rejects non-UUID session_id without calling the server', async () => {
    const tool = getTool(api, 'klodi_register_poll')
    const result = await tool.execute('call-1', {
      session_id: '../../admin',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('UUID')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('writes creds with mode 0o600 in a single syscall (no TOCTOU window)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => completedResponse,
    })

    const tool = getTool(api, 'klodi_register_poll')
    await tool.execute('call-1', { session_id: FIXED_UUID })

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-klodi/nats.creds',
      'CREDS_CONTENT_HERE',
      expect.objectContaining({
        encoding: 'utf-8',
        mode: 0o600,
      }),
    )
  })

  it('cancels the background poll after a terminal tool call', async () => {
    // Surface-level integration: calling klodi_register_poll must leave
    // no live interval behind. The deeper invariant (no duplicate wake
    // even when a background fetch is in flight during the tool's
    // execution) is exercised as a unit-level test on the poller —
    // see register-poller.test.ts 'post-await active check suppresses
    // a wake when stopped during an in-flight claim'.
    vi.useFakeTimers()
    try {
      mockHasCreds.mockReturnValueOnce(false)
      const registerTool = getTool(api, 'klodi_register')
      await registerTool.execute('call-1', {})

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => completedResponse,
      })
      const pollTool = getTool(api, 'klodi_register_poll')
      await pollTool.execute('call-2', { session_id: FIXED_UUID })

      // Background interval must be cleared — no further fetches fire.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── klodi_whoami ────────────────────────────────────────────────────────────

describe('klodi_whoami', () => {
  it('forwards to p2p.v1.users.whoami and returns response', async () => {
    const whoamiData = {
      handle: 'testuser',
      rating_avg: 4.5,
      total_trades: 12,
      location_area: 'Athens, GR',
    }
    mockRequest.mockResolvedValueOnce(whoamiData)

    const tool = getTool(api, 'klodi_whoami')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.users.whoami', {})
    const data = JSON.parse(result.content[0].text!)
    expect(data.handle).toBe('testuser')
    expect(data.rating_avg).toBe(4.5)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_whoami')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_health ────────────────────────────────────────────────────────────

describe('klodi_health', () => {
  it('returns healthy when files exist, NATS connected, and whoami succeeds', async () => {
    mockExistsSync.mockReturnValue(true)
    mockIsConnected.mockReturnValue(true)
    mockRequest.mockResolvedValueOnce({
      handle: 'testuser',
      rating_avg: 4.5,
      total_trades: 3,
    })

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('healthy')
    expect(data.handle).toBe('testuser')
    expect(data.nats_connected).toBe(true)
    expect(data.whoami_ok).toBe(true)
    expect(mockRequest).toHaveBeenCalledWith(
      'p2p.v1.users.whoami',
      {},
      expect.objectContaining({ timeout: 3_000 }),
    )
  })

  it('lists issues when creds missing', async () => {
    mockExistsSync
      .mockReturnValueOnce(false)  // nats.creds not found
      .mockReturnValueOnce(true)   // config.json found

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('unhealthy')
    expect(data.issues).toContain('nats.creds not found')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('lists issues when NATS disconnected (skips whoami probe)', async () => {
    mockExistsSync.mockReturnValue(true)
    mockIsConnected.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('unhealthy')
    expect(data.issues).toContain('NATS not connected')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('lists multiple issues when both creds and NATS missing', async () => {
    mockExistsSync.mockReturnValue(false)
    mockIsConnected.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('unhealthy')
    expect(data.issues).toHaveLength(3)
    expect(data.issues).toContain('nats.creds not found')
    expect(data.issues).toContain('config.json not found')
    expect(data.issues).toContain('NATS not connected')
  })

  it('reports whoami_failed when the live probe times out', async () => {
    mockExistsSync.mockReturnValue(true)
    mockIsConnected.mockReturnValue(true)
    mockRequest.mockRejectedValueOnce(new Error('timeout'))

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('unhealthy')
    expect(data.whoami_ok).toBe(false)
    expect(data.issues[0]).toContain('whoami_failed')
    expect(data.issues[0]).toContain('timeout')
  })

  it('reports whoami_failed when the server returns an error envelope', async () => {
    mockExistsSync.mockReturnValue(true)
    mockIsConnected.mockReturnValue(true)
    mockRequest.mockResolvedValueOnce({
      error: 'unauthorized',
      message: 'invalid credentials',
    })

    const tool = getTool(api, 'klodi_health')
    const result = await tool.execute('call-1', {})

    const data = JSON.parse(result.content[0].text!)
    expect(data.status).toBe('unhealthy')
    expect(data.whoami_ok).toBe(false)
    expect(data.issues[0]).toContain('unauthorized')
  })

  it('triggers ensureNatsRunning to recover from a transient connect failure', async () => {
    // Regression guard: after register-claim the initial bootstrap may race
    // and leave the connection down. klodi_health must actively re-probe via
    // ensureNatsRunning (not just read isConnected) so a single health call
    // recovers without a gateway restart. The retry happens BEFORE the
    // isConnected() check, so the current connection state is irrelevant —
    // what matters is that the probe fires exactly once when creds+config
    // are both present on disk.
    mockExistsSync.mockReturnValue(true)
    mockIsConnected.mockReturnValue(false)
    mockEnsureNats.mockResolvedValueOnce({
      status: 'failed',
      reason: 'wsconnect rejected',
    })

    const tool = getTool(api, 'klodi_health')
    await tool.execute('call-1', {})

    expect(mockEnsureNats).toHaveBeenCalledTimes(1)
    expect(mockEnsureNats).toHaveBeenCalledWith(api)
  })

  it('skips ensureNatsRunning when credential files are missing', async () => {
    // No point probing the NATS connection when the user is not registered —
    // ensureNatsRunning would just short-circuit on hasCredentials()=false
    // and emit another onboarding wake. klodi_health already reports the
    // missing files as issues; the probe call is wasted work.
    mockExistsSync.mockReturnValue(false)
    mockIsConnected.mockReturnValue(false)

    const tool = getTool(api, 'klodi_health')
    await tool.execute('call-1', {})

    expect(mockEnsureNats).not.toHaveBeenCalled()
  })
})

// ── klodi_ratings ───────────────────────────────────────────────────────────

describe('klodi_ratings', () => {
  it('forwards handle to p2p.v1.ratings.query', async () => {
    const ratingsData = {
      handle: 'alice',
      average: 4.8,
      count: 25,
      ratings: [{ stars: 5, comment: 'Great seller' }],
    }
    mockRequest.mockResolvedValueOnce(ratingsData)

    const tool = getTool(api, 'klodi_ratings')
    const result = await tool.execute('call-1', { handle: 'alice' })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.ratings.query', {
      handle: 'alice',
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.handle).toBe('alice')
    expect(data.average).toBe(4.8)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_ratings')
    const result = await tool.execute('call-1', { handle: 'alice' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns NATS error as tool error', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'not_found',
      message: 'User not found',
    })

    const tool = getTool(api, 'klodi_ratings')
    const result = await tool.execute('call-1', { handle: 'ghost' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not_found')
    expect(result.content[0].text).toContain('User not found')
  })
})
