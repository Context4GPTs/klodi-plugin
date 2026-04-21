/**
 * Tests for src/tools/transactions.ts
 * Tools: klodi_tx_confirm, klodi_tx_cancel, klodi_tx_rate, klodi_tx_status
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
import { onTransactionTerminal } from '../../service/state.js'
import { registerTransactionTools } from '../../tools/transactions.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)
const mockOnTerminal = vi.mocked(onTransactionTerminal)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'
const TX_ID = '880e8400-e29b-41d4-a716-446655440003'

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerTransactionTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_tx_confirm ────────────────────────────────────────────────────────

describe('klodi_tx_confirm', () => {
  it('forwards transaction_id to p2p.v1.transactions.confirm', async () => {
    const confirmData = {
      transaction_id: TX_ID,
      status: 'buyer_confirmed',
      listing_id: LISTING_ID,
    }
    mockRequest.mockResolvedValueOnce(confirmData)

    const tool = getTool(api, 'klodi_tx_confirm')
    const result = await tool.execute('call-1', { transaction_id: TX_ID })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.transactions.confirm', {
      transaction_id: TX_ID,
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.transaction_id).toBe(TX_ID)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_tx_confirm')
    const result = await tool.execute('call-1', { transaction_id: TX_ID })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_tx_cancel ─────────────────────────────────────────────────────────

describe('klodi_tx_cancel', () => {
  it('forwards transaction_id and reason to p2p.v1.transactions.cancel', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      status: 'cancelled',
    })

    const tool = getTool(api, 'klodi_tx_cancel')
    const result = await tool.execute('call-1', {
      transaction_id: TX_ID,
      reason: 'no_show',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.transactions.cancel', {
      transaction_id: TX_ID,
      reason: 'no_show',
    })
  })

  it('calls onTransactionTerminal on success with listing_id', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      status: 'cancelled',
    })

    const tool = getTool(api, 'klodi_tx_cancel')
    await tool.execute('call-1', {
      transaction_id: TX_ID,
      reason: 'changed_mind',
    })

    expect(mockOnTerminal).toHaveBeenCalledWith(LISTING_ID)
  })

  it('does not call onTransactionTerminal on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'not_found',
      message: 'Transaction not found',
    })

    const tool = getTool(api, 'klodi_tx_cancel')
    const result = await tool.execute('call-1', {
      transaction_id: TX_ID,
      reason: 'other',
    })

    expect(result.isError).toBe(true)
    expect(mockOnTerminal).not.toHaveBeenCalled()
  })

  it('does not call onTransactionTerminal when response has no listing_id', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      status: 'cancelled',
      // no listing_id in response
    })

    const tool = getTool(api, 'klodi_tx_cancel')
    await tool.execute('call-1', {
      transaction_id: TX_ID,
      reason: 'changed_mind',
    })

    expect(mockOnTerminal).not.toHaveBeenCalled()
  })
})

// ── klodi_tx_rate ───────────────────────────────────────────────────────────

describe('klodi_tx_rate', () => {
  it('forwards transaction_id, rating, and optional comment', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      rated: true,
    })

    const tool = getTool(api, 'klodi_tx_rate')
    const result = await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 5,
      comment: 'Excellent seller',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.transactions.rate', {
      transaction_id: TX_ID,
      rating: 5,
      comment: 'Excellent seller',
    })
  })

  it('does not include comment when not provided', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      rated: true,
    })

    const tool = getTool(api, 'klodi_tx_rate')
    await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 4,
    })

    const payload = mockRequest.mock.calls[0][1]
    expect(payload).not.toHaveProperty('comment')
    expect(payload).toEqual({
      transaction_id: TX_ID,
      rating: 4,
    })
  })

  it('calls onTransactionTerminal on success with listing_id', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      rated: true,
    })

    const tool = getTool(api, 'klodi_tx_rate')
    await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 5,
    })

    expect(mockOnTerminal).toHaveBeenCalledWith(LISTING_ID)
  })

  it('logs sell_file_cleaned on successful rating', async () => {
    mockRequest.mockResolvedValueOnce({
      transaction_id: TX_ID,
      listing_id: LISTING_ID,
      rated: true,
    })

    const tool = getTool(api, 'klodi_tx_rate')
    await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 4,
    })

    expect(api.logger.info).toHaveBeenCalledWith(
      'sell_file_cleaned',
      { listing_id: LISTING_ID },
    )
  })

  it('does not clean up on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'already_rated',
      message: 'Already rated this transaction',
    })

    const tool = getTool(api, 'klodi_tx_rate')
    const result = await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 3,
    })

    expect(result.isError).toBe(true)
    expect(mockOnTerminal).not.toHaveBeenCalled()
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_tx_rate')
    const result = await tool.execute('call-1', {
      transaction_id: TX_ID,
      rating: 5,
    })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_tx_status ─────────────────────────────────────────────────────────

describe('klodi_tx_status', () => {
  it('forwards transaction_id to p2p.v1.transactions.status', async () => {
    const statusData = {
      transaction_id: TX_ID,
      status: 'awaiting_confirmation',
      buyer_confirmed: true,
      seller_confirmed: false,
      next_action: 'Seller must confirm the exchange.',
    }
    mockRequest.mockResolvedValueOnce(statusData)

    const tool = getTool(api, 'klodi_tx_status')
    const result = await tool.execute('call-1', { transaction_id: TX_ID })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.transactions.status', {
      transaction_id: TX_ID,
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.transaction_id).toBe(TX_ID)
    expect(data.next_action).toBe('Seller must confirm the exchange.')
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_tx_status')
    const result = await tool.execute('call-1', { transaction_id: TX_ID })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
