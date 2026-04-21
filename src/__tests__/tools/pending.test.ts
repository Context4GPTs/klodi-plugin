/**
 * Tests for src/tools/pending.ts
 *
 * Uses a real temp KLODI_HOME so sell/buy markdown files exercise
 * the actual parser pipeline. nats-client is mocked because pending
 * now calls gatherChecks() to surface setup state — the whoami probe
 * is opt-out per the `probe: false` contract, but isConnected() is
 * still called cheaply and needs a deterministic answer in tests.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMockPluginApi,
  getTool,
  type MockPluginAPI,
} from '../helpers/mock-plugin-api.js'
import { createTempHome, type TempHome } from '../helpers/temp-home.js'

vi.mock('../../lib/nats-client.js', () => ({
  isConnected: vi.fn(() => false),
  request: vi.fn(),
  getConnection: vi.fn(),
  drain: vi.fn(),
  WHOAMI_PROBE_TIMEOUT_MS: 3_000,
}))

import { isConnected, request } from '../../lib/nats-client.js'
import { registerPendingTool } from '../../tools/pending.js'
import {
  getCredsPath,
  getConfigPath,
  getNegotiationStylePath,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from '../../lib/config.js'

const mockIsConnected = vi.mocked(isConnected)
const mockRequest = vi.mocked(request)

interface PendingResponse {
  setup_required: boolean
  setup_phase:
    | 'unregistered'
    | 'corrupt'
    | 'degraded'
    | 'needs_heartbeat'
    | 'needs_policy'
    | 'ready'
  open_questions: Array<{
    slug: string
    listing_id: string
    asker: string
    asked_on: string
    question: string
  }>
  active_negotiations: Array<{
    slug: string
    listing_id: string | null
    channel_id: string
    counterparty: string
    agreed_price_cents: number | null
    agreed_terms_summary: string | null
    pending: string
  }>
}

const VALID_CONFIG = {
  handle: 'testuser',
  user_id: 'uid-123',
  nkey_public: 'NKEY',
  nats_url: 'nats://localhost:4222',
}

// Default `every` = "1m" — a valid cadence well under the 120_000 ms (2
// minute) ceiling setup-state enforces. Pass `null` to OMIT the key so
// tests can verify the "missing every" rejection path.
function heartbeatConfig(
  target: string,
  every: string | null = '1m',
): Record<string, unknown> {
  const heartbeat: Record<string, unknown> = { target }
  if (every !== null) heartbeat.every = every
  return { agents: { defaults: { heartbeat } } }
}

/** Seed the filesystem so derivePhase resolves to `ready`. */
function seedReadyState(): void {
  writeFileSync(getCredsPath(), 'CREDS_CONTENT', 'utf-8')
  writeFileSync(getConfigPath(), JSON.stringify(VALID_CONFIG), 'utf-8')
  seedSecurityPolicyIfAbsent()
  seedNegotiationStyleIfAbsent()
  // Seeded negotiation_style.md has template placeholders that
  // `isNegotiationStyleFilled()` rejects. Overwrite with a filled copy
  // so the phase derivation reaches `ready`.
  writeFileSync(
    getNegotiationStylePath(),
    '# Negotiation Style\n\n## Posture\n\nfirm\n',
    'utf-8',
  )
}

const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_LISTING_ID = '660e8400-e29b-41d4-a716-446655440001'

let api: MockPluginAPI
let home: TempHome

beforeEach(() => {
  vi.clearAllMocks()
  home = createTempHome()
  // Heartbeat seeded to "last" so setup-state tests that want a
  // `ready` phase don't trip on the heartbeat gate. Tests that need a
  // different heartbeat rebuild the api locally.
  api = createMockPluginApi({ config: heartbeatConfig('last') })
  registerPendingTool(api)
  // Default: disconnected. Ready-state tests override to true.
  mockIsConnected.mockReturnValue(false)
})

afterEach(() => {
  home.cleanup()
})

function writeSell(slug: string, body: string, listingId = LISTING_ID): void {
  const fm = [
    '---',
    `listing_id: ${listingId}`,
    'min_acceptable_price: null',
    'auto_reject_below: null',
    'transaction_id: null',
    'check_every: 2h',
    '---',
  ].join('\n')
  writeFileSync(join(home.sellDir, `${slug}.md`), `${fm}\n\n${body}\n`, 'utf-8')
}

function writeBuy(slug: string, body: string): void {
  const fm = [
    '---',
    'query: test',
    'max_price: null',
    'target_price: null',
    'delivery_method: any',
    'pickup_radius: null',
    'ships_to: null',
    'action_on_match: notify',
    'check_every: 4h',
    'last_checked: null',
    '---',
  ].join('\n')
  writeFileSync(join(home.buyDir, `${slug}.md`), `${fm}\n\n${body}\n`, 'utf-8')
}

async function callPending(): Promise<PendingResponse> {
  const tool = getTool(api, 'klodi_pending')
  const result = await tool.execute('call-1', {})
  return JSON.parse(result.content[0].text!) as PendingResponse
}

// ─── registration ───────────────────────────────────────────────────────────

describe('klodi_pending registration', () => {
  it('registers the tool with zero parameters', () => {
    const tool = getTool(api, 'klodi_pending')

    expect(tool.name).toBe('klodi_pending')
    // TypeBox Type.Object({}) yields { type: 'object', properties: {} }
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
    })
  })
})

// ─── empty filesystem ───────────────────────────────────────────────────────

describe('klodi_pending with no files', () => {
  it('returns empty lists when sell and buy dirs are empty', async () => {
    const res = await callPending()

    expect(res.open_questions).toEqual([])
    expect(res.active_negotiations).toEqual([])
  })
})

// ─── open questions (sell files only) ───────────────────────────────────────

describe('klodi_pending open_questions', () => {
  it('extracts unchecked open questions from a sell file', async () => {
    writeSell(
      'camera',
      [
        '## Open Questions',
        '- [ ] @buyer1 (2026-04-15): batteries included?',
        '- [ ] @buyer2 (2026-04-16): warranty transferable?',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.open_questions).toHaveLength(2)
    expect(res.open_questions[0]).toEqual({
      slug: 'camera',
      listing_id: LISTING_ID,
      asker: '@buyer1',
      asked_on: '2026-04-15',
      question: 'batteries included?',
    })
  })

  it('ignores checked-box items', async () => {
    writeSell(
      'camera',
      [
        '## Open Questions',
        '- [x] @done (2026-04-10): already answered',
        '- [ ] @live (2026-04-15): still pending',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.open_questions).toHaveLength(1)
    expect(res.open_questions[0].asker).toBe('@live')
  })

  it('ignores Open Questions in buy files (only sell side escalates)', async () => {
    // Buy files never contribute open_questions; the spec is that
    // buyers ask the seller, so escalation is a sell-side concern.
    writeBuy(
      'camera-hunt',
      [
        '## Open Questions',
        '- [ ] @seller1 (2026-04-15): should not appear',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.open_questions).toEqual([])
  })

  it('aggregates open questions across multiple sell files', async () => {
    writeSell(
      'camera',
      '## Open Questions\n- [ ] @a (2026-04-10): q1?',
      LISTING_ID,
    )
    writeSell(
      'laptop',
      '## Open Questions\n- [ ] @b (2026-04-11): q2?',
      OTHER_LISTING_ID,
    )

    const res = await callPending()

    expect(res.open_questions).toHaveLength(2)
    const slugs = res.open_questions.map((q) => q.slug).sort()
    expect(slugs).toEqual(['camera', 'laptop'])
  })

  it('returns empty open_questions when sell file has no Open Questions section', async () => {
    writeSell('camera', '## Private Facts\n- serial XYZ')

    const res = await callPending()

    expect(res.open_questions).toEqual([])
  })
})

// ─── active negotiations (sell + buy) ───────────────────────────────────────

describe('klodi_pending active_negotiations', () => {
  it('extracts negotiations from sell files with listing_id', async () => {
    writeSell(
      'camera',
      [
        '## Active Negotiations',
        '### Channel abc-123 — @buyer1',
        '- Agreed: $120, pickup Saturday',
        '- Pending: buyer to confirm pickup spot',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.active_negotiations).toHaveLength(1)
    expect(res.active_negotiations[0]).toEqual({
      slug: 'camera',
      listing_id: LISTING_ID,
      channel_id: 'abc-123',
      counterparty: '@buyer1',
      agreed_price_cents: 12000,
      agreed_terms_summary: '$120, pickup Saturday',
      pending: 'buyer to confirm pickup spot',
    })
  })

  it('extracts negotiations from buy files too', async () => {
    writeBuy(
      'camera-hunt',
      [
        '## Active Negotiations',
        '### Channel xyz-789 — @seller1',
        '- Agreed: $150 via Venmo',
        '- Pending: my decision on pickup spot',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.active_negotiations).toHaveLength(1)
    expect(res.active_negotiations[0].slug).toBe('camera-hunt')
    expect(res.active_negotiations[0].channel_id).toBe('xyz-789')
    expect(res.active_negotiations[0].counterparty).toBe('@seller1')
    expect(res.active_negotiations[0].agreed_price_cents).toBe(15000)
  })

  it('surfaces buy-file per-channel Listing bullet into active_negotiations[].listing_id', async () => {
    // End-to-end wire test: buy file → readBuyFile → extractSection →
    // parseActiveNegotiations (now reads `- Listing:` bullet per channel)
    // → collectFromBuy spreads `...n` → response carries listing_id.
    // Guards the pending.ts → parser integration beyond the parser's
    // own unit tests in markdown-sections.
    const BUY_CHANNEL_LISTING_ID = '770e8400-e29b-41d4-a716-446655440002'
    writeBuy(
      'camera-hunt',
      [
        '## Active Negotiations',
        '### Channel xyz-789 — @seller1',
        `- Listing: ${BUY_CHANNEL_LISTING_ID}`,
        '- Agreed: $100',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.active_negotiations[0].listing_id).toBe(
      BUY_CHANNEL_LISTING_ID,
    )
    expect(res.active_negotiations[0].slug).toBe('camera-hunt')
  })

  it('concatenates negotiations across both sell and buy files', async () => {
    writeSell(
      'camera',
      '## Active Negotiations\n### Channel s1 — @buyer1\n- Agreed: $10',
    )
    writeBuy(
      'laptop-hunt',
      '## Active Negotiations\n### Channel b1 — @seller1\n- Agreed: $20',
    )

    const res = await callPending()

    expect(res.active_negotiations).toHaveLength(2)
    const slugs = res.active_negotiations.map((n) => n.slug).sort()
    expect(slugs).toEqual(['camera', 'laptop-hunt'])
  })

  it('returns null agreed_price_cents when Agreed lacks a dollar figure', async () => {
    writeSell(
      'camera',
      [
        '## Active Negotiations',
        '### Channel abc — @buyer1',
        '- Agreed: pickup Saturday at Devoción (price TBD)',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.active_negotiations[0].agreed_price_cents).toBeNull()
    expect(res.active_negotiations[0].agreed_terms_summary).toContain(
      'pickup Saturday',
    )
  })

  it('leaves pending empty when no Pending bullet present', async () => {
    writeSell(
      'camera',
      '## Active Negotiations\n### Channel abc — @buyer1\n- Agreed: $50',
    )

    const res = await callPending()

    expect(res.active_negotiations[0].pending).toBe('')
  })
})

// ─── edge cases / robustness ────────────────────────────────────────────────

describe('klodi_pending robustness', () => {
  it('skips malformed sell files silently (returns null from readSellFile)', async () => {
    // Write a file with no frontmatter — readSellFile should still
    // return a SellFile with the raw content in body.
    writeFileSync(
      join(home.sellDir, 'broken.md'),
      'no frontmatter at all, just content',
      'utf-8',
    )
    // Plus a good file
    writeSell('good', '## Open Questions\n- [ ] @a (2026-01-01): ok?')

    const res = await callPending()

    // Good file still contributes
    expect(res.open_questions).toHaveLength(1)
    expect(res.open_questions[0].slug).toBe('good')
  })

  it('ignores non-.md files in sell/buy dirs', async () => {
    writeFileSync(join(home.sellDir, 'notes.txt'), 'ignore me', 'utf-8')
    writeSell('camera', '## Open Questions\n- [ ] @a (2026-01-01): q?')

    const res = await callPending()

    expect(res.open_questions).toHaveLength(1)
    expect(res.open_questions[0].slug).toBe('camera')
  })

  it('returns consistent shape { open_questions, active_negotiations }', async () => {
    const res = await callPending()

    expect(res).toHaveProperty('open_questions')
    expect(res).toHaveProperty('active_negotiations')
    expect(Array.isArray(res.open_questions)).toBe(true)
    expect(Array.isArray(res.active_negotiations)).toBe(true)
  })

  it('handles a full-featured sell file (both sections)', async () => {
    writeSell(
      'camera',
      [
        '## Private Facts',
        '- Serial XYZ-999',
        '',
        '## Public Knowledge',
        '- USB-C',
        '',
        '## Open Questions',
        '- [ ] @b1 (2026-04-15): warranty?',
        '',
        '## Logistics Plan',
        '### Pickup',
        '- Williamsburg',
        '',
        '## Active Negotiations',
        '### Channel ch-1 — @b1',
        '- Agreed: $200',
        '- Pending: pickup time',
      ].join('\n'),
    )

    const res = await callPending()

    expect(res.open_questions).toHaveLength(1)
    expect(res.active_negotiations).toHaveLength(1)
    expect(res.active_negotiations[0].agreed_price_cents).toBe(20000)
  })
})

// ─── setup state (unregistered, corrupt, degraded, ready) ───────────────────

describe('klodi_pending setup_required', () => {
  it('sets setup_required=true and phase=unregistered when no creds', async () => {
    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('unregistered')
  })

  it('sets phase=corrupt when creds exist but config is missing', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('corrupt')
  })

  it('sets phase=corrupt when config is missing required fields', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ handle: 'only' }),
      'utf-8',
    )

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('corrupt')
  })

  it('sets phase=degraded when registered but NATS not connected', async () => {
    seedReadyState()
    // Leave mockIsConnected at default (false) — this simulates NATS
    // down while credentials are intact.

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('degraded')
  })

  it('sets phase=needs_heartbeat when heartbeat target is not "last"', async () => {
    // Rebuild the api with a wrong heartbeat target so readApiConfig
    // resolves to something other than "last".
    api = createMockPluginApi({ config: heartbeatConfig('none') })
    registerPendingTool(api)
    seedReadyState()
    mockIsConnected.mockReturnValue(true)

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('needs_heartbeat')
  })

  it('sets phase=needs_policy when negotiation_style has placeholders', async () => {
    writeFileSync(getCredsPath(), 'CREDS', 'utf-8')
    writeFileSync(getConfigPath(), JSON.stringify(VALID_CONFIG), 'utf-8')
    seedSecurityPolicyIfAbsent()
    // Seed the bundled template untouched — contains placeholders.
    seedNegotiationStyleIfAbsent()
    mockIsConnected.mockReturnValue(true)

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.setup_phase).toBe('needs_policy')
  })

  it('sets setup_required=false and phase=ready when fully provisioned', async () => {
    seedReadyState()
    mockIsConnected.mockReturnValue(true)

    const res = await callPending()

    expect(res.setup_required).toBe(false)
    expect(res.setup_phase).toBe('ready')
  })

  it('never calls whoami — probe must stay off in the hot path', async () => {
    seedReadyState()
    mockIsConnected.mockReturnValue(true)

    await callPending()

    // klodi_pending runs at every session start. A NATS round-trip
    // per session would be unacceptable latency — guard the contract.
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns pending items AND setup_required together in one response', async () => {
    // When the user is mid-setup but also has pending items from a
    // prior registered state (e.g. mid-corrupt), surface both. SKILL.md
    // routes on setup_required first, but the digest stays intact.
    writeSell(
      'camera',
      '## Open Questions\n- [ ] @b1 (2026-04-15): ships?',
    )

    const res = await callPending()

    expect(res.setup_required).toBe(true)
    expect(res.open_questions).toHaveLength(1)
  })
})
