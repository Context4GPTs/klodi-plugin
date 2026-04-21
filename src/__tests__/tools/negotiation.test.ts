/**
 * Tests for src/tools/negotiation.ts
 * Tools: klodi_channel_create, klodi_channel_mine, klodi_channel_send, klodi_channel_history
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

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { request } from '../../lib/nats-client.js'
import { hasCredentials } from '../../lib/config.js'
import { registerNegotiationTools } from '../../tools/negotiation.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'
const CHANNEL_ID = '660e8400-e29b-41d4-a716-446655440001'
const MSG_ID = '770e8400-e29b-41d4-a716-446655440002'

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerNegotiationTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_channel_create ────────────────────────────────────────────────────

describe('klodi_channel_create', () => {
  it('forwards listing_id to p2p.v1.channels.create', async () => {
    const channelData = { channel_id: CHANNEL_ID, listing_id: LISTING_ID }
    mockRequest.mockResolvedValueOnce(channelData)

    const tool = getTool(api, 'klodi_channel_create')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.create', {
      listing_id: LISTING_ID,
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.channel_id).toBe(CHANNEL_ID)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_channel_create')
    const result = await tool.execute('call-1', { listing_id: LISTING_ID })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_channel_mine ──────────────────────────────────────────────────────

describe('klodi_channel_mine', () => {
  it('forwards status filter when provided', async () => {
    mockRequest.mockResolvedValueOnce({ channels: [] })

    const tool = getTool(api, 'klodi_channel_mine')
    await tool.execute('call-1', { status: 'open' })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.mine', {
      status: 'open',
    })
  })

  it('sends empty payload when no status filter', async () => {
    mockRequest.mockResolvedValueOnce({ channels: [] })

    const tool = getTool(api, 'klodi_channel_mine')
    await tool.execute('call-1', {})

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.mine', {})
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_channel_mine')
    const result = await tool.execute('call-1', {})

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_channel_send ──────────────────────────────────────────────────────

describe('klodi_channel_send', () => {
  it('forwards channel_id and content to p2p.v1.channels.send', async () => {
    const sendResult = { message_id: MSG_ID, channel_id: CHANNEL_ID }
    mockRequest.mockResolvedValueOnce(sendResult)

    const tool = getTool(api, 'klodi_channel_send')
    const result = await tool.execute('call-1', {
      channel_id: CHANNEL_ID,
      content: 'Would you take $120?',
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.send', {
      channel_id: CHANNEL_ID,
      content: 'Would you take $120?',
    })
    const data = JSON.parse(result.content[0].text!)
    expect(data.message_id).toBe(MSG_ID)
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_channel_send')
    const result = await tool.execute('call-1', {
      channel_id: CHANNEL_ID,
      content: 'Hello',
    })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

// ── klodi_channel_history ───────────────────────────────────────────────────

describe('klodi_channel_history', () => {
  it('forwards channel_id with cursor params', async () => {
    const historyData = {
      messages: [{ message_id: MSG_ID, content: 'Hi' }],
    }
    mockRequest.mockResolvedValueOnce(historyData)

    const tool = getTool(api, 'klodi_channel_history')
    const result = await tool.execute('call-1', {
      channel_id: CHANNEL_ID,
      limit: 10,
      before: MSG_ID,
    })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.history', {
      channel_id: CHANNEL_ID,
      limit: 10,
      before: MSG_ID,
    })
  })

  it('sends only channel_id when no cursors provided', async () => {
    mockRequest.mockResolvedValueOnce({ messages: [] })

    const tool = getTool(api, 'klodi_channel_history')
    await tool.execute('call-1', { channel_id: CHANNEL_ID })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.history', {
      channel_id: CHANNEL_ID,
    })
  })

  it('includes after cursor for forward pagination', async () => {
    mockRequest.mockResolvedValueOnce({ messages: [] })

    const tool = getTool(api, 'klodi_channel_history')
    await tool.execute('call-1', {
      channel_id: CHANNEL_ID,
      after: MSG_ID,
    })

    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.channels.history', {
      channel_id: CHANNEL_ID,
      after: MSG_ID,
    })
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_channel_history')
    const result = await tool.execute('call-1', { channel_id: CHANNEL_ID })

    expect(result.isError).toBe(true)
    expect(mockRequest).not.toHaveBeenCalled()
  })
})
