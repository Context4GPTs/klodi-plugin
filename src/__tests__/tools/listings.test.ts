/**
 * Tests for src/tools/listings.ts
 * Tools: klodi_list_create, klodi_list_get, klodi_list_mine,
 *        klodi_list_update, klodi_list_withdraw, klodi_list_relist
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

vi.mock('../../service/state.js', () => ({
  onListingCreated: vi.fn(() => 'test-slug'),
  onListingWithdrawn: vi.fn(),
  onListingRelisted: vi.fn(() => 'relisted-slug'),
  onListingUpdated: vi.fn(),
  onOfferAccepted: vi.fn(),
  onTransactionTerminal: vi.fn(),
  onBuySearchCreated: vi.fn(),
  onBuySearchRemoved: vi.fn(),
  getSellFileForListing: vi.fn(),
  readSellFile: vi.fn(),
  readBuyFile: vi.fn(),
}))

vi.mock('../../service/timers.js', () => ({
  createSellTimer: vi.fn(),
  createBuyTimer: vi.fn(),
  clearItemTimer: vi.fn(),
  clearAllTimers: vi.fn(),
  initTimers: vi.fn(),
  reconcileTimers: vi.fn(),
}))

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { request } from '../../lib/nats-client.js'
import { hasCredentials } from '../../lib/config.js'
import { onListingCreated, onListingWithdrawn, onListingRelisted, onListingUpdated } from '../../service/state.js'
import { createSellTimer } from '../../service/timers.js'
import { registerListingTools } from '../../tools/listings.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)
const mockOnCreated = vi.mocked(onListingCreated)
const mockOnWithdrawn = vi.mocked(onListingWithdrawn)
const mockOnRelisted = vi.mocked(onListingRelisted)
const mockOnUpdated = vi.mocked(onListingUpdated)
const mockCreateSellTimer = vi.mocked(createSellTimer)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'

const MINIMAL_CREATE_PARAMS = {
  title: 'Vintage Keyboard',
  description: 'Mechanical keyboard in great condition',
  category: 'electronics',
  asking_price: 15000,
  delivery_method: 'ship',
}

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerListingTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_list_create ───────────────────────────────────────────────────────

describe('klodi_list_create', () => {
  it('sends correct payload to p2p.v1.listings.create', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, title: 'Vintage Keyboard' })

    const tool = getTool(api, 'klodi_list_create')
    await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.create', {
      title: 'Vintage Keyboard',
      description: 'Mechanical keyboard in great condition',
      category: 'electronics',
      asking_price: 15000,
      delivery_method: 'ship',
    })
  })

  it('includes optional fields only when provided', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID })

    const tool = getTool(api, 'klodi_list_create')
    await tool.execute('call-1', {
      ...MINIMAL_CREATE_PARAMS,
      condition: 'good',
      ships_to: ['US', 'CA'],
      tags: ['vintage', 'mechanical'],
      currency: 'EUR',
      expires_hours: 72,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.create', {
      title: 'Vintage Keyboard',
      description: 'Mechanical keyboard in great condition',
      category: 'electronics',
      asking_price: 15000,
      delivery_method: 'ship',
      condition: 'good',
      ships_to: ['US', 'CA'],
      tags: ['vintage', 'mechanical'],
      currency: 'EUR',
      expires_hours: 72,
    })
  })

  it('creates sell file on success with listing_id and slug', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, title: 'Vintage Keyboard' })
    mockOnCreated.mockReturnValueOnce('vintage-keyboard')

    const tool = getTool(api, 'klodi_list_create')
    await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(mockOnCreated).toHaveBeenCalledWith('Vintage Keyboard', LISTING_ID)
  })

  it('creates sell timer on success', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID })
    mockOnCreated.mockReturnValueOnce('vintage-keyboard')

    const tool = getTool(api, 'klodi_list_create')
    await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(mockCreateSellTimer).toHaveBeenCalledWith('vintage-keyboard')
  })

  it('returns sell_file slug and path so the agent edits the plugin file instead of inventing its own', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, title: 'Vintage Keyboard' })
    mockOnCreated.mockReturnValueOnce('vintage-keyboard-550e84')

    const tool = getTool(api, 'klodi_list_create')
    const result = await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.sell_file).toEqual({
      slug: 'vintage-keyboard-550e84',
      path: '/tmp/test-klodi/sell/vintage-keyboard-550e84.md',
      hint: expect.stringContaining('Never create a separate'),
    })
  })

  it('does not include sell_file when state side-effect throws', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID })
    mockOnCreated.mockImplementationOnce(() => { throw new Error('disk full') })

    const tool = getTool(api, 'klodi_list_create')
    const result = await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    const data = JSON.parse(result.content[0].text!)
    expect(data).not.toHaveProperty('sell_file')
  })

  it('does not create sell file on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'validation_error',
      message: 'Title is required',
    })

    const tool = getTool(api, 'klodi_list_create')
    const result = await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(result.isError).toBe(true)
    expect(mockOnCreated).not.toHaveBeenCalled()
    expect(mockCreateSellTimer).not.toHaveBeenCalled()
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_list_create')
    const result = await tool.execute('call-1', MINIMAL_CREATE_PARAMS)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_list_get ──────────────────────────────────────────────────────────

describe('klodi_list_get', () => {
  it('forwards listing_id to p2p.v1.listings.get', async () => {
    const listingData = {
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      asking_price: 15000,
      status: 'active',
    }
    mockRequest.mockResolvedValueOnce(listingData)

    const tool = getTool(api, 'klodi_list_get')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.get', {
      listing_id: LISTING_ID,
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.listing_id).toBe(LISTING_ID)
  })
})

// ── klodi_list_mine ─────────────────────────────────────────────────────────

describe('klodi_list_mine', () => {
  it('forwards status filter when provided', async () => {
    mockRequest.mockResolvedValueOnce({ listings: [] })

    const tool = getTool(api, 'klodi_list_mine')
    await tool.execute('call-1', { status: 'active' })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.mine', {
      status: 'active',
    })
  })

  it('sends empty payload when no filter', async () => {
    mockRequest.mockResolvedValueOnce({ listings: [] })

    const tool = getTool(api, 'klodi_list_mine')
    await tool.execute('call-1', {})

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.mine', {})
  })
})

// ── klodi_list_update ───────────────────────────────────────────────────────

describe('klodi_list_update', () => {
  it('sends only provided fields plus listing_id', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, title: 'Updated Title' })

    const tool = getTool(api, 'klodi_list_update')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      title: 'Updated Title',
      asking_price: 12000,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.update', {
      listing_id: LISTING_ID,
      title: 'Updated Title',
      asking_price: 12000,
    })
  })

  it('does not include undefined optional fields', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID })

    const tool = getTool(api, 'klodi_list_update')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    const callPayload = mockRequest.mock.calls[0][1]
    expect(callPayload).toEqual({ listing_id: LISTING_ID })
    expect(Object.keys(callPayload)).toEqual(['listing_id'])
  })

  it('calls onListingUpdated with asking_price on success', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Updated Title',
      asking_price: 12000,
    })

    const tool = getTool(api, 'klodi_list_update')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      title: 'Updated Title',
      asking_price: 12000,
    })

    expect(mockOnUpdated).toHaveBeenCalledWith(
      LISTING_ID,
      { asking_price: 12000 },
    )
  })

  it('does not call onListingUpdated when asking_price is omitted', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'New Title',
    })

    const tool = getTool(api, 'klodi_list_update')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      title: 'New Title',
    })

    expect(mockOnUpdated).not.toHaveBeenCalled()
  })

  it('does not call onListingUpdated on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'LISTING_NOT_FOUND',
      message: 'Not found',
    })

    const tool = getTool(api, 'klodi_list_update')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      asking_price: 12000,
    })

    expect(mockOnUpdated).not.toHaveBeenCalled()
  })
})

// ── klodi_list_withdraw ─────────────────────────────────────────────────────

describe('klodi_list_withdraw', () => {
  it('sends status: withdrawn to p2p.v1.listings.update', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, status: 'withdrawn' })

    const tool = getTool(api, 'klodi_list_withdraw')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.update', {
      listing_id: LISTING_ID,
      status: 'withdrawn',
    })
  })

  it('deletes sell file and clears timer on success', async () => {
    mockRequest.mockResolvedValueOnce({ listing_id: LISTING_ID, status: 'withdrawn' })

    const tool = getTool(api, 'klodi_list_withdraw')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(mockOnWithdrawn).toHaveBeenCalledWith(LISTING_ID)
  })

  it('does not delete sell file on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'not_found',
      message: 'Listing not found',
    })

    const tool = getTool(api, 'klodi_list_withdraw')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBe(true)
    expect(mockOnWithdrawn).not.toHaveBeenCalled()
  })
})

// ── klodi_list_relist ───────────────────────────────────────────────────────

describe('klodi_list_relist', () => {
  it('sends status: active to p2p.v1.listings.update', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      status: 'active',
    })

    const tool = getTool(api, 'klodi_list_relist')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.update', {
      listing_id: LISTING_ID,
      status: 'active',
    })
  })

  it('includes asking_price when provided', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      status: 'active',
    })

    const tool = getTool(api, 'klodi_list_relist')
    await tool.execute('call-1', {
      listing_id: LISTING_ID,
      asking_price: 10000,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.listings.update', {
      listing_id: LISTING_ID,
      status: 'active',
      asking_price: 10000,
    })
  })

  it('ensures sell file exists on success', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      status: 'active',
    })
    mockOnRelisted.mockReturnValueOnce('vintage-keyboard')

    const tool = getTool(api, 'klodi_list_relist')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(mockOnRelisted).toHaveBeenCalledWith(LISTING_ID, 'Vintage Keyboard')
  })

  it('creates sell timer on success', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      status: 'active',
    })
    mockOnRelisted.mockReturnValueOnce('vintage-keyboard')

    const tool = getTool(api, 'klodi_list_relist')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(mockCreateSellTimer).toHaveBeenCalledWith('vintage-keyboard')
  })

  it('returns sell_file slug and path on success', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      title: 'Vintage Keyboard',
      status: 'active',
    })
    mockOnRelisted.mockReturnValueOnce('vintage-keyboard-550e84')

    const tool = getTool(api, 'klodi_list_relist')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text!)
    expect(data.sell_file).toEqual({
      slug: 'vintage-keyboard-550e84',
      path: '/tmp/test-klodi/sell/vintage-keyboard-550e84.md',
      hint: expect.stringContaining('Never create a separate'),
    })
  })

  it('uses listing_id as fallback title when response has no title', async () => {
    mockRequest.mockResolvedValueOnce({
      listing_id: LISTING_ID,
      status: 'active',
    })

    const tool = getTool(api, 'klodi_list_relist')
    await tool.execute('call-1', { listing_id: LISTING_ID })

    // When response has no title, falls back to listingId
    expect(mockOnRelisted).toHaveBeenCalledWith(LISTING_ID, LISTING_ID)
  })

  it('does not create sell file on error response', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'forbidden',
      message: 'Cannot relist',
    })

    const tool = getTool(api, 'klodi_list_relist')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBe(true)
    expect(mockOnRelisted).not.toHaveBeenCalled()
    expect(mockCreateSellTimer).not.toHaveBeenCalled()
  })
})
