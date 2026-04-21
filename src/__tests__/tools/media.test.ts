/**
 * Tests for src/tools/media.ts
 * Tools: klodi_photo_upload
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
import { registerMediaTools } from '../../tools/media.js'

const mockRequest = vi.mocked(request)
const mockHasCreds = vi.mocked(hasCredentials)

// ── Setup ───────────────────────────────────────────────────────────────────

let api: MockPluginAPI

beforeEach(() => {
  vi.clearAllMocks()
  api = createMockPluginApi()
  registerMediaTools(api)
  mockHasCreds.mockReturnValue(true)
})

// ── klodi_photo_upload ──────────────────────────────────────────────────────

describe('klodi_photo_upload', () => {
  it('forwards files array to p2p.v1.assets.upload-url', async () => {
    const files = [
      { filename: 'photo1.jpg', content_type: 'image/jpeg', size: 1_048_576 },
      { filename: 'photo2.png', content_type: 'image/png', size: 524_288 },
    ]
    const uploadResponse = {
      uploads: [
        {
          filename: 'photo1.jpg',
          upload_url: 'https://r2.example.com/put/photo1.jpg?sig=abc',
          asset_url: 'https://cdn.klodi.4gpts.com/assets/photo1.jpg',
        },
        {
          filename: 'photo2.png',
          upload_url: 'https://r2.example.com/put/photo2.png?sig=def',
          asset_url: 'https://cdn.klodi.4gpts.com/assets/photo2.png',
        },
      ],
    }
    mockRequest.mockResolvedValueOnce(uploadResponse)

    const tool = getTool(api, 'klodi_photo_upload')
    const result = await tool.execute('call-1', { files })

    expect(result.isError).toBeFalsy()
    expect(mockRequest).toHaveBeenCalledWith('p2p.v1.assets.upload-url', {
      files,
    }, { timeout: 30_000 })
    const data = JSON.parse(result.content[0].text!)
    expect(data.uploads).toHaveLength(2)
    expect(data.uploads[0].upload_url).toContain('photo1.jpg')
  })

  it('returns error when not registered', async () => {
    mockHasCreds.mockReturnValueOnce(false)

    const tool = getTool(api, 'klodi_photo_upload')
    const result = await tool.execute('call-1', {
      files: [
        { filename: 'test.jpg', content_type: 'image/jpeg', size: 100 },
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Not registered')
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns NATS error as tool error', async () => {
    mockRequest.mockResolvedValueOnce({
      error: 'too_many_files',
      message: 'Maximum 10 files per request',
    })

    const tool = getTool(api, 'klodi_photo_upload')
    const result = await tool.execute('call-1', {
      files: [
        { filename: 'test.jpg', content_type: 'image/jpeg', size: 100 },
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('too_many_files')
  })
})
