/**
 * Tests for src/tools/discovery.ts
 * Tools: klodi_search, klodi_watch, klodi_comment
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockPluginApi, getTool, type MockPluginAPI } from '../helpers/mock-plugin-api.js'

// ── Mocks (hoisted before imports) ──────────────────────────────────────────

vi.mock('../../lib/nats-client.js', () => ({
  request: vi.fn(),
  getConnection: vi.fn(),
  isConnected: vi.fn(() => true),
  drain: vi.fn(),
}))

vi.mock('../../service/state.js', () => ({
  onBuySearchCreated: vi.fn(),
  onBuySearchRemoved: vi.fn(),
}))

vi.mock('../../service/timers.js', () => ({
  createBuyTimer: vi.fn(),
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
  getSellFilePath: vi.fn((slug: string) => `/tmp/test-klodi/sell/${slug}.md`),
  getBuyFilePath: vi.fn((slug: string) => `/tmp/test-klodi/buy/${slug}.md`),
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
}))

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { request } from '../../lib/nats-client.js'
import { hasCredentials } from '../../lib/config.js'
import { onBuySearchRemoved } from '../../service/state.js'
import { registerDiscoveryTools } from '../../tools/discovery.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)
const mockOnBuySearchRemoved = vi.mocked(onBuySearchRemoved)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerDiscoveryTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_search ────────────────────────────────────────────────────────────

describe('klodi_search', () => {
  it('maps pickup_radius to pickup_radius_km in NATS payload', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_search')
    await tool.execute('call-1', {
      query: 'keyboard',
      pickup_radius: 25,
    })

    const payload = mockRequest.mock.calls[0][1]
    expect(payload).toHaveProperty('pickup_radius_km', 25)
    expect(payload).not.toHaveProperty('pickup_radius')
  })

  it('sends only provided filters', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_search')
    await tool.execute('call-1', { query: 'laptop' })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.search', {
      query: 'laptop',
    })
  })

  it('includes all filter fields when provided', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_search')
    await tool.execute('call-1', {
      query: 'keyboard',
      delivery_method: 'ship',
      min_price: 5000,
      max_price: 20000,
      pickup_radius: 50,
      ships_to: 'US',
      limit: 10,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.search', {
      query: 'keyboard',
      delivery_method: 'ship',
      min_price: 5000,
      max_price: 20000,
      pickup_radius_km: 50,
      ships_to: 'US',
      limit: 10,
    })
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_search')
    const result = await tool.execute('call-1', { query: 'test' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_watch ─────────────────────────────────────────────────────────────

describe('klodi_watch', () => {
  it('includes since parameter when provided', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })
    const sinceTs = '2026-04-15T12:00:00Z'

    const tool = getTool(api, 'klodi_watch')
    await tool.execute('call-1', {
      query: 'vintage',
      since: sinceTs,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.watch', {
      query: 'vintage',
      since: sinceTs,
    })
  })

  it('maps pickup_radius to pickup_radius_km', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_watch')
    await tool.execute('call-1', {
      query: 'keyboard',
      pickup_radius: 10,
    })

    const payload = mockRequest.mock.calls[0][1]
    expect(payload).toHaveProperty('pickup_radius_km', 10)
    expect(payload).not.toHaveProperty('pickup_radius')
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_watch')
    const result = await tool.execute('call-1', { query: 'test' })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns buy_file slug and path when persist=true so the agent edits the plugin file instead of inventing its own', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_watch')
    const result = await tool.execute('call-1', {
      query: 'gaming laptop',
      persist: true,
    })

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.buy_file).toMatchObject({
      slug: expect.stringContaining('gaming-laptop'),
      path: expect.stringMatching(/\/tmp\/test-klodi\/buy\/gaming-laptop[^/]*\.md$/),
      hint: expect.stringContaining('Never create a separate'),
    })
  })

  it('does not include buy_file when persist is not set', async () => {
    mockRequest.mockResolvedValueOnce({ results: [] })

    const tool = getTool(api, 'klodi_watch')
    const result = await tool.execute('call-1', { query: 'gaming laptop' })

    const data = JSON.parse(result.content[0].text!)
    expect(data).not.toHaveProperty('buy_file')
  })
})

// ── klodi_comment ───────────────────────────────────────────────────────────

describe('klodi_comment', () => {
  it('forwards listing_id and body to p2p.v1.comments.create', async () => {
    const commentResponse = { comment_id: 'cmt-001', body: 'Nice item!' }
    mockRequest.mockResolvedValueOnce(commentResponse)

    const tool = getTool(api, 'klodi_comment')
    const result = await tool.execute('call-1', {
      listing_id: LISTING_ID,
      body: 'Nice item!',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.comments.create', {
      listing_id: LISTING_ID,
      body: 'Nice item!',
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.comment_id).toBe('cmt-001')
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_comment')
    const result = await tool.execute('call-1', {
      listing_id: LISTING_ID,
      body: 'Hello',
    })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_unwatch ───────────────────────────────────────────────────────────

describe('klodi_unwatch', () => {
  const BUY_SLUG = 'gaming-laptop-abc123'

  it('calls onBuySearchRemoved with the provided buy_slug', async () => {
    const tool = getTool(api, 'klodi_unwatch')
    await tool.execute('call-1', { buy_slug: BUY_SLUG })

    expect(mockOnBuySearchRemoved).toHaveBeenCalledTimes(1)
    expect(mockOnBuySearchRemoved).toHaveBeenCalledWith(BUY_SLUG)
  })

  it('returns a success message', async () => {
    const tool = getTool(api, 'klodi_unwatch')
    const result = await tool.execute('call-1', { buy_slug: BUY_SLUG })

    expect(result.isError).toBeFalsy()
    const text = result.content[0].text ?? ''
    const lowered = text.toLowerCase()
    expect(
      lowered.includes('removed') || text.includes(BUY_SLUG),
    ).toBe(true)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_unwatch')
    const result = await tool.execute('call-1', { buy_slug: BUY_SLUG })

    expect(result.isError).toBe(true)
    expect(mockOnBuySearchRemoved).not.toHaveBeenCalled()
  })
})
