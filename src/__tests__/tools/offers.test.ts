/**
 * Tests for src/tools/offers.ts
 * Tools: klodi_offer_create, klodi_offer_respond, klodi_offer_mine
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
}))

vi.mock('../../service/state.js', () => ({
  onListingCreated: vi.fn(() => 'test-slug'),
  onListingWithdrawn: vi.fn(),
  onListingRelisted: vi.fn(() => 'test-slug'),
  onListingUpdated: vi.fn(),
  onOfferAccepted: vi.fn(),
  onTransactionTerminal: vi.fn(),
  onBuySearchCreated: vi.fn(),
  onBuySearchRemoved: vi.fn(),
  getSellFileForListing: vi.fn(),
  readSellFile: vi.fn(),
  readBuyFile: vi.fn(),
}))

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { request } from '../../lib/nats-client.js'
import { hasCredentials } from '../../lib/config.js'
import { onOfferAccepted } from '../../service/state.js'
import { registerOfferTools } from '../../tools/offers.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)
const mockOnOfferAccepted = vi.mocked(onOfferAccepted)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'
const CHANNEL_ID = '660e8400-e29b-41d4-a716-446655440001'
const OFFER_ID = '770e8400-e29b-41d4-a716-446655440002'

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerOfferTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_offer_create ──────────────────────────────────────────────────────

describe('klodi_offer_create', () => {
  it('sends listing_id, channel_id, amount, currency', async () => {
    const offerResponse = { offer_id: OFFER_ID, status: 'proposed' }
    mockRequest.mockResolvedValueOnce(offerResponse)

    const tool = getTool(api, 'klodi_offer_create')
    const result = await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.create', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.offer_id).toBe(OFFER_ID)
  })

  it('includes optional message when provided', async () => {
    mockRequest.mockResolvedValueOnce({ offer_id: OFFER_ID })

    const tool = getTool(api, 'klodi_offer_create')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      message: 'Best I can do',
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.create', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      message: 'Best I can do',
    })
  })

  it('does not include message when not provided', async () => {
    mockRequest.mockResolvedValueOnce({ offer_id: OFFER_ID })

    const tool = getTool(api, 'klodi_offer_create')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
    })

    const payload = mockRequest.mock.calls[0][1]
    expect(payload).not.toHaveProperty('message')
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_offer_create')
    const result = await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
    })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('forwards terms object to the NATS payload when provided', async () => {
    mockRequest.mockResolvedValueOnce({ offer_id: OFFER_ID })

    const terms = {
      condition_confirmed: 'good',
      fulfillment: {
        method: 'pickup',
        pickup: {
          area: 'Williamsburg',
          spot: 'Devoción',
          window: '2026-04-20T18:00:00Z/2026-04-20T20:00:00Z',
        },
      },
      payment: { method: 'venmo', timing: 'on_pickup' },
      inclusions: ['original charger'],
      exclusions: ['batteries'],
    }

    const tool = getTool(api, 'klodi_offer_create')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      terms,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.create', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      terms,
    })
  })

  it('omits terms from payload when not provided', async () => {
    mockRequest.mockResolvedValueOnce({ offer_id: OFFER_ID })

    const tool = getTool(api, 'klodi_offer_create')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
    })

    const payload = mockRequest.mock.calls[0][1]
    expect(payload).not.toHaveProperty('terms')
  })

  it('forwards terms alongside message when both provided', async () => {
    mockRequest.mockResolvedValueOnce({ offer_id: OFFER_ID })

    const tool = getTool(api, 'klodi_offer_create')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      message: 'See terms',
      terms: { fulfillment: { method: 'digital' } },
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.create', {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 12000,
      currency: 'USD',
      message: 'See terms',
      terms: { fulfillment: { method: 'digital' } },
    })
  })
})

// ── klodi_offer_respond ─────────────────────────────────────────────────────

describe('klodi_offer_respond', () => {
  it('forwards offer_id and action to p2p.v1.offers.respond', async () => {
    const respondResult = {
      offer_id: OFFER_ID,
      listing_id: LISTING_ID,
      status: 'accepted',
    }
    mockRequest.mockResolvedValueOnce(respondResult)

    const tool = getTool(api, 'klodi_offer_respond')
    const result = await tool.execute('call-1', {
      offer_id: OFFER_ID,
      action: 'accept',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.respond', {
      offer_id: OFFER_ID,
      action: 'accept',
    })
  })

  it('calls onOfferAccepted on accept with listing_id and transaction_id', async () => {
    mockRequest.mockResolvedValueOnce({
      offer_id: OFFER_ID,
      listing_id: LISTING_ID,
      transaction_id: "tx-123",
      status: 'accepted',
    })

    const tool = getTool(api, 'klodi_offer_respond')
    await tool.execute('call-1', {
      offer_id: OFFER_ID,
      action: 'accept',
    })

    expect(mockOnOfferAccepted).toHaveBeenCalledWith(LISTING_ID, "tx-123")
  })

  it('does not call onOfferAccepted on reject', async () => {
    mockRequest.mockResolvedValueOnce({
      offer_id: OFFER_ID,
      listing_id: LISTING_ID,
      status: 'rejected',
    })

    const tool = getTool(api, 'klodi_offer_respond')
    await tool.execute('call-1', {
      offer_id: OFFER_ID,
      action: 'reject',
    })

    expect(mockOnOfferAccepted).not.toHaveBeenCalled()
  })

  it('does not call onOfferAccepted on accept when response has error', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'conflict',
      message: 'Offer already responded',
    })

    const tool = getTool(api, 'klodi_offer_respond')
    const result = await tool.execute('call-1', {
      offer_id: OFFER_ID,
      action: 'accept',
    })

    expect(result.isError).toBe(true)
    expect(mockOnOfferAccepted).not.toHaveBeenCalled()
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_offer_respond')
    const result = await tool.execute('call-1', {
      offer_id: OFFER_ID,
      action: 'accept',
    })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_offer_mine ────────────────────────────────────────────────────────

describe('klodi_offer_mine', () => {
  it('forwards status and role filters', async () => {
    mockRequest.mockResolvedValueOnce({ offers: [] })

    const tool = getTool(api, 'klodi_offer_mine')
    await tool.execute('call-1', {
      status: 'proposed',
      role: 'buyer',
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.mine', {
      status: 'proposed',
      role: 'buyer',
    })
  })

  it('sends empty payload when no filters', async () => {
    mockRequest.mockResolvedValueOnce({ offers: [] })

    const tool = getTool(api, 'klodi_offer_mine')
    await tool.execute('call-1', {})

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.offers.mine', {})
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_offer_mine')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
