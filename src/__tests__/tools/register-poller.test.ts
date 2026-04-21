/**
 * Tests for src/tools/register-poller.ts
 *
 * The register-poller owns the post-klodi_register polling loop. It runs
 * inside the plugin process (not in the agent's shell) so that a completion
 * landing after OpenClaw would have torn down an agent-spawned subprocess
 * still gets written to disk and wakes the agent.
 *
 * Spec (no implementation yet — tests drive RED):
 *   - claimRegisterSession(api, sessionId): one HTTP claim attempt against
 *     GET {apiUrl}/api/sessions/{sessionId}. Returns a discriminated union
 *     describing the terminal or non-terminal state.
 *   - startRegisterPoll(api, sessionId): setInterval at 5s cadence,
 *     capped at 10 minutes (SESSION_EXPIRY_MS). On terminal state it
 *     wakes the agent via enqueueSystemEvent + requestHeartbeatNow
 *     (mirroring src/service/notifications.ts:167-170).
 *   - stopRegisterPoll(reason): halts the active interval. Idempotent.
 *
 * Boundaries mocked: global fetch, node:fs, ../../lib/config.js,
 * ../../service/nats.js. No real HTTP, no real filesystem, no real NATS.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createMockPluginApi,
  type MockPluginAPI,
} from '../helpers/mock-plugin-api.js'

// ── Mocks (hoisted before imports) ──────────────────────────────────────────

vi.mock('../../lib/config.js', () => ({
  getApiUrl: vi.fn(() => 'https://test.klodi.4gpts.com'),
  getKlodiHome: vi.fn(() => '/tmp/test-klodi'),
  getCredsPath: vi.fn(() => '/tmp/test-klodi/nats.creds'),
  getSellDir: vi.fn(() => '/tmp/test-klodi/sell'),
  getBuyDir: vi.fn(() => '/tmp/test-klodi/buy'),
  getPoliciesDir: vi.fn(() => '/tmp/test-klodi/policies'),
  writeConfig: vi.fn(),
  seedNegotiationStyleIfAbsent: vi.fn(() => false),
  seedSecurityPolicyIfAbsent: vi.fn(() => false),
}))

vi.mock('../../service/nats.js', () => ({
  ensureNatsRunning: vi.fn().mockResolvedValue({ status: 'running' }),
  resetNatsState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}))

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  getApiUrl,
  writeConfig,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from '../../lib/config.js'
import { ensureNatsRunning, resetNatsState } from '../../service/nats.js'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import {
  startRegisterPoll,
  stopRegisterPoll,
  claimRegisterSession,
} from '../../tools/register-poller.js'

const mockGetApiUrl = vi.mocked(getApiUrl)
const mockWriteConfig = vi.mocked(writeConfig)
const mockSeedNegotiationStyle = vi.mocked(seedNegotiationStyleIfAbsent)
const mockSeedSecurity = vi.mocked(seedSecurityPolicyIfAbsent)
const mockEnsureNats = vi.mocked(ensureNatsRunning)
const mockResetNatsState = vi.mocked(resetNatsState)
const mockMkdirSync = vi.mocked(mkdirSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockChmodSync = vi.mocked(chmodSync)

// ── Setup ───────────────────────────────────────────────────────────────────

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_SESSION_ID = '660e8400-e29b-41d4-a716-446655440111'
const POLL_URL = `https://test.klodi.4gpts.com/api/sessions/${SESSION_ID}`
const OTHER_POLL_URL = `https://test.klodi.4gpts.com/api/sessions/${OTHER_SESSION_ID}`

const completedPayload = {
  status: 'completed',
  handle: 'newuser',
  user_id: 'new-user-id',
  nkey_public: 'NKEY456',
  nats_url: 'nats://prod:4222',
  nats_creds: 'CREDS_CONTENT_HERE',
}

let api: MockPluginAPI
let mockFetch: ReturnType<typeof vi.fn>

function okJson(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => body }
}

function errorJson(
  status: number,
  statusText: string,
  body: unknown,
): {
  ok: false
  status: number
  statusText: string
  json: () => Promise<unknown>
} {
  return { ok: false, status, statusText, json: async () => body }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()

  api = createMockPluginApi()
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)

  // Restore default mock implementations after clearAllMocks wipes them.
  mockGetApiUrl.mockReturnValue('https://test.klodi.4gpts.com')
  mockSeedNegotiationStyle.mockReturnValue(false)
  mockSeedSecurity.mockReturnValue(false)
  mockEnsureNats.mockResolvedValue({ status: 'running' })
  mockResetNatsState.mockResolvedValue(undefined)
})

afterEach(() => {
  stopRegisterPoll('test_cleanup')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ── claimRegisterSession ────────────────────────────────────────────────────

describe('claimRegisterSession', () => {
  it('returns registered with full payload on completed HTTP-200 response', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))
    mockSeedNegotiationStyle.mockReturnValueOnce(true)
    mockSeedSecurity.mockReturnValueOnce(true)
    mockEnsureNats.mockResolvedValueOnce({ status: 'running' })

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({
      kind: 'registered',
      handle: 'newuser',
      negotiation_style_seeded: true,
      security_policy_seeded: true,
      nats_connected: true,
      nats_reason: undefined,
    })
  })

  it('fetches the /api/sessions/:id URL derived from getApiUrl()', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

    await claimRegisterSession(api, SESSION_ID)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      POLL_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'user-agent': expect.stringMatching(/^klodi-plugin\//),
        }),
      }),
    )
  })

  it('propagates nats failure reason when bootstrap fails on registered', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))
    mockEnsureNats.mockResolvedValueOnce({
      status: 'failed',
      reason: 'ECONNREFUSED',
    })

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result.kind).toBe('registered')
    if (result.kind !== 'registered') throw new Error('unreachable')
    expect(result.nats_connected).toBe(false)
    expect(result.nats_reason).toBe('ECONNREFUSED')
  })

  it('writes creds with mode 0o600 and chmods them on registered', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

    await claimRegisterSession(api, SESSION_ID)

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-klodi/nats.creds',
      'CREDS_CONTENT_HERE',
      { encoding: 'utf-8', mode: 0o600 },
    )
    expect(mockChmodSync).toHaveBeenCalledWith(
      '/tmp/test-klodi/nats.creds',
      0o600,
    )
  })

  it('creates klodi home, sell, buy, and policies directories on registered', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

    await claimRegisterSession(api, SESSION_ID)

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi', {
      recursive: true,
    })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi/sell', {
      recursive: true,
    })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi/buy', {
      recursive: true,
    })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-klodi/policies', {
      recursive: true,
    })
  })

  it('writes config and seeds both policies on registered', async () => {
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

    await claimRegisterSession(api, SESSION_ID)

    expect(mockWriteConfig).toHaveBeenCalledWith({
      handle: 'newuser',
      user_id: 'new-user-id',
      nkey_public: 'NKEY456',
      nats_url: 'nats://prod:4222',
    })
    expect(mockSeedNegotiationStyle).toHaveBeenCalledTimes(1)
    expect(mockSeedSecurity).toHaveBeenCalledTimes(1)
  })

  it('drains stale NATS (resetNatsState) BEFORE ensureNatsRunning on registered', async () => {
    // Regression guard: ensureNatsRunning short-circuits on
    // (consuming && isConnected()), so without resetNatsState() beforehand
    // the plugin would keep talking to NATS with the prior user's creds.
    // Mirror of the identity.test.ts callOrder assertion.
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

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

    await claimRegisterSession(api, SESSION_ID)

    expect(callOrder).toEqual([
      'writeConfig',
      'resetNatsState',
      'ensureNatsRunning',
    ])
  })

  it('returns pending for a pending session without any writes', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ status: 'pending' }))

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({ kind: 'pending' })
    expect(mockWriteConfig).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockMkdirSync).not.toHaveBeenCalled()
    expect(mockResetNatsState).not.toHaveBeenCalled()
    expect(mockEnsureNats).not.toHaveBeenCalled()
  })

  it('returns expired for an expired session without any writes', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ status: 'expired' }))

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({ kind: 'expired' })
    expect(mockWriteConfig).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockResetNatsState).not.toHaveBeenCalled()
    expect(mockEnsureNats).not.toHaveBeenCalled()
  })

  it('returns already_claimed on 409 with CREDENTIALS_ALREADY_CLAIMED error body', async () => {
    mockFetch.mockResolvedValueOnce(
      errorJson(409, 'Conflict', {
        error: 'CREDENTIALS_ALREADY_CLAIMED',
        message: 'session already consumed',
      }),
    )

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({ kind: 'already_claimed' })
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns http_error with status and statusText on non-2xx without the claim sentinel', async () => {
    mockFetch.mockResolvedValueOnce(
      errorJson(500, 'Internal Server Error', { error: 'SOMETHING_ELSE' }),
    )

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({
      kind: 'http_error',
      status: 500,
      statusText: 'Internal Server Error',
    })
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns http_error when non-2xx body is not parseable as JSON', async () => {
    // Not a CREDENTIALS_ALREADY_CLAIMED case because the body can't be read.
    // Must surface HTTP metadata rather than swallow it.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('not json')
      },
    })

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result).toEqual({
      kind: 'http_error',
      status: 502,
      statusText: 'Bad Gateway',
    })
  })

  it('returns transport_error with message when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'))

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result.kind).toBe('transport_error')
    if (result.kind !== 'transport_error') throw new Error('unreachable')
    expect(result.message).toContain('Network unreachable')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns invalid_response when completed payload is missing nats_creds', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        status: 'completed',
        handle: 'newuser',
        user_id: 'new-user-id',
        nkey_public: 'NKEY456',
        nats_url: 'nats://prod:4222',
        // nats_creds deliberately absent
      }),
    )

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result.kind).toBe('invalid_response')
    if (result.kind !== 'invalid_response') throw new Error('unreachable')
    expect(result.message).toMatch(/nats_creds|missing|required/i)
    expect(mockWriteConfig).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('returns invalid_response when completed payload is missing handle', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        status: 'completed',
        user_id: 'new-user-id',
        nkey_public: 'NKEY456',
        nats_url: 'nats://prod:4222',
        nats_creds: 'CREDS_CONTENT_HERE',
      }),
    )

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result.kind).toBe('invalid_response')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('returns invalid_response when completed field has wrong type (non-string handle)', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        status: 'completed',
        handle: 12345,
        user_id: 'new-user-id',
        nkey_public: 'NKEY456',
        nats_url: 'nats://prod:4222',
        nats_creds: 'CREDS_CONTENT_HERE',
      }),
    )

    const result = await claimRegisterSession(api, SESSION_ID)

    expect(result.kind).toBe('invalid_response')
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })
})

// ── startRegisterPoll ───────────────────────────────────────────────────────

describe('startRegisterPoll', () => {
  it('polls every 5000 ms — no call at t=0, one at t=5000, two at t=10000', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)

    // t=0: poller has just scheduled — no fetch yet.
    expect(mockFetch).not.toHaveBeenCalled()

    // t=5000: exactly one fetch.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]?.[0]).toBe(POLL_URL)

    // t=10000: exactly two fetches.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  // wakeAgent signature: enqueueSystemEvent(text, { sessionKey }),
  // requestHeartbeatNow({ reason: "hook:klodi:<reason>", sessionKey }).
  // The default mock api.config is {}, so sessionKey resolves to
  // "agent:main:main". The "hook:klodi:" prefix on the heartbeat
  // reason is required so OpenClaw's resolveHeartbeatReasonKind
  // classifier treats the call as kind="hook" (isWakeReason=true);
  // see wake.ts invariant #5 — without it the preflight gates on
  // HEARTBEAT.md and the queued system event never fires.
  const EXPECTED_SESSION_KEY = 'agent:main:main'

  it('wakes the agent with a success message and stops polling on registered', async () => {
    // First tick returns completed; no further ticks should fetch.
    mockFetch.mockResolvedValueOnce(okJson(completedPayload))

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(5_000)
    // Flush any remaining chained awaits inside the claim path
    // (resetNatsState, ensureNatsRunning, then the wake).
    await vi.advanceTimersByTimeAsync(0)

    const enqueue = vi.mocked(api.runtime.system.enqueueSystemEvent)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [text, options] = enqueue.mock.calls[0]
    expect(text).toContain('Registration complete')
    expect(text).toContain('@newuser')
    expect(text).toContain('klodi_setup_status')
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY })

    const heartbeat = vi.mocked(api.runtime.system.requestHeartbeatNow)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat).toHaveBeenCalledWith({
      reason: 'hook:klodi:klodi-register-complete',
      sessionKey: EXPECTED_SESSION_KEY,
    })

    // Polling must be stopped — advancing further fires no fetch.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('wakes the agent with an expired message and stops polling on expired', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ status: 'expired' }))

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)

    const enqueue = vi.mocked(api.runtime.system.enqueueSystemEvent)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [text, options] = enqueue.mock.calls[0]
    expect(text.toLowerCase()).toContain('expired')
    expect(text).toContain('klodi_register')
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY })

    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'hook:klodi:klodi-register-expired',
      sessionKey: EXPECTED_SESSION_KEY,
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('wakes the agent with an already-claimed message and stops polling on 409', async () => {
    mockFetch.mockResolvedValueOnce(
      errorJson(409, 'Conflict', {
        error: 'CREDENTIALS_ALREADY_CLAIMED',
      }),
    )

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)

    const enqueue = vi.mocked(api.runtime.system.enqueueSystemEvent)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [text, options] = enqueue.mock.calls[0]
    expect(text.toLowerCase()).toContain('already claimed')
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY })

    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'hook:klodi:klodi-register-already-claimed',
      sessionKey: EXPECTED_SESSION_KEY,
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps polling without waking on transient transport errors', async () => {
    // Two network failures, then pending — poll must survive both errors.
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(15_000) // three ticks
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled()
    expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled()
  })

  it('keeps polling without waking on transient HTTP 500 errors', async () => {
    mockFetch
      .mockResolvedValueOnce(
        errorJson(500, 'Internal Server Error', { error: 'SOMETHING_ELSE' }),
      )
      .mockResolvedValueOnce(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(10_000) // two ticks
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled()
    expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled()
  })

  it('does NOT wake before 10 minutes of pending', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)

    // Advance 9m55s — must not have woken.
    await vi.advanceTimersByTimeAsync(595_000)
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled()
    expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled()
  })

  it('wakes with a timeout message after 10 minutes of pending and stops polling', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)

    // 10 minutes = 600_000 ms. First 5s tick lands at t=5s; the 120th tick
    // at t=600s is the ceiling.
    await vi.advanceTimersByTimeAsync(600_000)
    await vi.advanceTimersByTimeAsync(0)

    const enqueue = vi.mocked(api.runtime.system.enqueueSystemEvent)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [text, options] = enqueue.mock.calls[0]
    expect(text).toContain('10 minutes')
    expect(text).toContain('klodi_register')
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY })

    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'hook:klodi:klodi-register-timeout',
      sessionKey: EXPECTED_SESSION_KEY,
    })

    // After the timeout wake, polling must stop — further advance: no new
    // fetches beyond the ones that already fired in the 10-minute window.
    const fetchCountAtTimeout = mockFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockFetch.mock.calls.length).toBe(fetchCountAtTimeout)
  })

  it('replaces the active session when started twice — only the second session is fetched', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)
    startRegisterPoll(api, OTHER_SESSION_ID)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]?.[0]).toBe(OTHER_POLL_URL)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // Every call must be against the new session, never the first one.
    for (const [url] of mockFetch.mock.calls) {
      expect(url).toBe(OTHER_POLL_URL)
    }
  })

  it('treats invalid_response as terminal — wakes and stops polling', async () => {
    // Server bug: completed status with missing required fields. Further
    // polls cannot recover, so the poller must bail rather than flood logs.
    mockFetch.mockResolvedValueOnce(
      okJson({
        status: 'completed',
        handle: 'newuser',
        // required fields missing
      }),
    )

    startRegisterPoll(api, SESSION_ID)

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)

    const enqueue = vi.mocked(api.runtime.system.enqueueSystemEvent)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [text, options] = enqueue.mock.calls[0]
    expect(text.toLowerCase()).toContain('malformed')
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY })

    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'hook:klodi:klodi-register-invalid-response',
      sessionKey: EXPECTED_SESSION_KEY,
    })

    // Polling must stop — a server bug won't heal itself.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ── post-await invariant (race protection) ────────────────────────────────

describe('pollOnce post-await check', () => {
  it('suppresses the wake when stopRegisterPoll runs during an in-flight claim', async () => {
    // Regression for the tool-vs-background race. Sequence:
    //   1. Background tick fires → claimRegisterSession's fetch is in flight.
    //   2. Before the fetch resolves, a caller (e.g. klodi_register_poll)
    //      calls stopRegisterPoll to take over.
    //   3. The background fetch then resolves with a terminal status
    //      (the worst case is a late `registered` / `already_claimed` that
    //      would otherwise fire a duplicate wake).
    //   4. The post-await check at register-poller.ts:pollOnce sees
    //      active === null and returns silently — no enqueueSystemEvent,
    //      no requestHeartbeatNow.
    //
    // Removing the post-await check would make this test fail.
    let resolveFetch!: (value: Response) => void
    mockFetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )

    startRegisterPoll(api, SESSION_ID)
    await vi.advanceTimersByTimeAsync(5_000) // fire one tick
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Caller stops the poll while the background fetch is still pending.
    stopRegisterPoll('external_preempt')

    // Background fetch resolves late with a terminal response.
    resolveFetch({
      ok: true,
      json: async () => completedPayload,
    } as unknown as Response)
    await vi.advanceTimersByTimeAsync(10)

    // The post-await re-check must have observed active === null.
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled()
    expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled()
  })
})

// ── stopRegisterPoll ────────────────────────────────────────────────────────

describe('stopRegisterPoll', () => {
  it('halts the interval — no fetches after stop', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    stopRegisterPoll('manual')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('is safe to call when no poll is active', () => {
    expect(() => stopRegisterPoll('no_active_poll')).not.toThrow()
  })

  it('is idempotent when called twice in a row', async () => {
    mockFetch.mockResolvedValue(okJson({ status: 'pending' }))

    startRegisterPoll(api, SESSION_ID)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(() => {
      stopRegisterPoll('first')
      stopRegisterPoll('second')
    }).not.toThrow()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
