/**
 * Tests for src/lib/markdown-sections.ts
 *
 * Adversarial parser tests for sell/buy file body sections.
 * Covers: extractSection, parseOpenQuestions, parseActiveNegotiations,
 * extractPriceCents. Tolerance for imperfect agent-authored markdown
 * is part of the contract, so fuzz the inputs.
 */

import { describe, it, expect } from 'vitest'
import {
  extractSection,
  parseOpenQuestions,
  parseActiveNegotiations,
  extractPriceCents,
} from '../../lib/markdown-sections.js'

// ─── extractSection ─────────────────────────────────────────────────────────

describe('extractSection', () => {
  it('returns content between target heading and next ## header', () => {
    const body = [
      '## Private Facts',
      '- Serial XYZ',
      '',
      '## Open Questions',
      '- [ ] @buyer1 (2026-04-15): batteries included?',
      '',
      '## Logistics Plan',
      '- Pickup: Brooklyn',
    ].join('\n')

    const result = extractSection(body, 'Open Questions')

    expect(result).toBe('- [ ] @buyer1 (2026-04-15): batteries included?')
  })

  it('returns section content all the way to EOF when no next header', () => {
    const body = [
      '## Public Knowledge',
      '- USB-C',
      '',
      '## Active Negotiations',
      '### Channel abc — @buyer1',
      '- Agreed: $120',
    ].join('\n')

    const result = extractSection(body, 'Active Negotiations')

    expect(result).toContain('### Channel abc — @buyer1')
    expect(result).toContain('- Agreed: $120')
  })

  it('returns empty string when heading is absent', () => {
    const body = '## Other Section\n- thing\n'

    expect(extractSection(body, 'Open Questions')).toBe('')
  })

  it('returns empty string for empty body', () => {
    expect(extractSection('', 'Open Questions')).toBe('')
  })

  it('does not match ### subheadings as section terminators', () => {
    // The next-section detector must only stop at ## headers,
    // otherwise Active Negotiations body gets truncated at its own ###.
    const body = [
      '## Active Negotiations',
      '### Channel 1 — @a',
      '- Agreed: $50',
      '### Channel 2 — @b',
      '- Agreed: $60',
      '## Logistics Plan',
      '- Pickup',
    ].join('\n')

    const result = extractSection(body, 'Active Negotiations')

    expect(result).toContain('### Channel 1')
    expect(result).toContain('### Channel 2')
    expect(result).not.toContain('Logistics Plan')
    expect(result).not.toContain('Pickup')
  })

  it('tolerates leading/trailing whitespace on the heading line', () => {
    const body = '##   Open Questions   \n- [ ] @a (2026-01-01): q?\n'

    const result = extractSection(body, 'Open Questions')

    expect(result).toContain('- [ ] @a (2026-01-01): q?')
  })

  it('does not match a heading that is only a prefix of the target', () => {
    const body = '## Open\n- not a match\n## Open Questions\n- [ ] @b (2026-01-01): q?\n'

    const result = extractSection(body, 'Open Questions')

    // Must extract from the actual match, not from "## Open"
    expect(result).toBe('- [ ] @b (2026-01-01): q?')
  })

  it('returns empty string for absent heading even when body is non-empty', () => {
    const body = '## Wrong Header\n- content\n'
    expect(extractSection(body, 'Correct Header')).toBe('')
  })
})

// ─── parseOpenQuestions ─────────────────────────────────────────────────────

describe('parseOpenQuestions', () => {
  it('parses a single well-formed unchecked item', () => {
    const section = '- [ ] @buyer1 (2026-04-15): does it come with batteries?'

    const result = parseOpenQuestions(section)

    expect(result).toEqual([
      {
        asker: '@buyer1',
        asked_on: '2026-04-15',
        question: 'does it come with batteries?',
      },
    ])
  })

  it('parses multiple unchecked items', () => {
    const section = [
      '- [ ] @alice (2026-04-10): warranty transferable?',
      '- [ ] @bob_99 (2026-04-11): any visible wear?',
    ].join('\n')

    const result = parseOpenQuestions(section)

    expect(result).toHaveLength(2)
    expect(result[0].asker).toBe('@alice')
    expect(result[1].asker).toBe('@bob_99')
  })

  it('ignores checked items (- [x] or - [X])', () => {
    const section = [
      '- [x] @done (2026-04-10): answered',
      '- [X] @also_done (2026-04-11): also answered',
      '- [ ] @open (2026-04-12): still pending',
    ].join('\n')

    const result = parseOpenQuestions(section)

    expect(result).toHaveLength(1)
    expect(result[0].asker).toBe('@open')
  })

  it('returns empty array for empty section', () => {
    expect(parseOpenQuestions('')).toEqual([])
  })

  it('returns empty array when no items match the pattern', () => {
    const section = '- just a prose bullet\n- another bullet'
    expect(parseOpenQuestions(section)).toEqual([])
  })

  it('tolerates extra whitespace around brackets and colon', () => {
    const section = '-  [ ]  @buyer1  (2026-04-15)  :  spaced out?'

    const result = parseOpenQuestions(section)

    expect(result).toHaveLength(1)
    expect(result[0].question).toBe('spaced out?')
  })

  it('ignores malformed date formats', () => {
    const section = [
      '- [ ] @a (04-15-2026): wrong date order',
      '- [ ] @b (2026/04/15): wrong separator',
      '- [ ] @c (2026-4-15): unpadded',
      '- [ ] @d (2026-04-15): good date',
    ].join('\n')

    const result = parseOpenQuestions(section)

    expect(result).toHaveLength(1)
    expect(result[0].asker).toBe('@d')
  })

  it('rejects missing @ prefix on handle', () => {
    const section = '- [ ] buyer1 (2026-04-15): no at-sign'
    expect(parseOpenQuestions(section)).toEqual([])
  })

  it('rejects handle longer than 30 chars', () => {
    const longHandle = 'a'.repeat(31)
    const section = `- [ ] @${longHandle} (2026-04-15): too long`
    expect(parseOpenQuestions(section)).toEqual([])
  })

  it('trims whitespace from the question body', () => {
    const section = '- [ ] @a (2026-04-15):    padded question text    '

    const result = parseOpenQuestions(section)

    expect(result[0].question).toBe('padded question text')
  })

  it('captures the full question when it contains punctuation', () => {
    const section = '- [ ] @a (2026-04-15): Can you ship to NY, NJ, or PA?'

    const result = parseOpenQuestions(section)

    expect(result[0].question).toBe('Can you ship to NY, NJ, or PA?')
  })
})

// ─── parseActiveNegotiations ────────────────────────────────────────────────

describe('parseActiveNegotiations', () => {
  it('parses a single channel block with agreed and pending', () => {
    const section = [
      '### Channel abc-123 — @buyer1',
      '- Agreed: $120, pickup Saturday',
      '- Pending: buyer confirmation',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toEqual([
      {
        channel_id: 'abc-123',
        counterparty: '@buyer1',
        listing_id: null,
        agreed_price_cents: 12000,
        agreed_terms_summary: '$120, pickup Saturday',
        pending: 'buyer confirmation',
      },
    ])
  })

  it('extracts listing_id from a "- Listing: <uuid>" bullet', () => {
    const section = [
      '### Channel abc-123 — @buyer1',
      '- Listing: 550e8400-e29b-41d4-a716-446655440000',
      '- Agreed: $120',
      '- Pending: buyer confirmation',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('leaves listing_id null when bullet contains unfilled <uuid> template', () => {
    const section = [
      '### Channel abc-123 — @buyer1',
      '- Listing: <uuid>',
      '- Agreed: $120',
      '- Pending: buyer confirmation',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBeNull()
  })

  it('parses multiple channel blocks', () => {
    const section = [
      '### Channel one — @alice',
      '- Agreed: $50',
      '- Pending: spot',
      '### Channel two — @bob',
      '- Agreed: $75',
      '- Pending: time',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(2)
    expect(result[0].channel_id).toBe('one')
    expect(result[0].counterparty).toBe('@alice')
    expect(result[1].channel_id).toBe('two')
    expect(result[1].counterparty).toBe('@bob')
  })

  it('accepts em-dash, hyphen, and double-hyphen separators', () => {
    const section = [
      '### Channel a — @u1',
      '- Agreed: $10',
      '### Channel b - @u2',
      '- Agreed: $20',
      '### Channel c -- @u3',
      '- Agreed: $30',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(3)
    expect(result.map((n) => n.counterparty)).toEqual(['@u1', '@u2', '@u3'])
  })

  it('strips literal angle brackets around <uuid> placeholder', () => {
    const section = [
      '### Channel <uuid> — @buyer1',
      '- Agreed: $100',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(1)
    expect(result[0].channel_id).toBe('uuid')
  })

  it('extracts price from "Agreed:" line into cents', () => {
    const section = [
      '### Channel x — @a',
      '- Agreed: $1,234.56 via Venmo',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result[0].agreed_price_cents).toBe(123456)
  })

  it('returns null price when Agreed line lacks a dollar figure', () => {
    const section = [
      '### Channel x — @a',
      '- Agreed: pickup spot confirmed only, price TBD',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result[0].agreed_price_cents).toBeNull()
  })

  it('leaves pending as empty string when not provided', () => {
    const section = [
      '### Channel x — @a',
      '- Agreed: $50',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result[0].pending).toBe('')
  })

  it('leaves agreed_terms_summary null and price null when no Agreed bullet', () => {
    const section = [
      '### Channel x — @a',
      '- Pending: just waiting',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result[0].agreed_terms_summary).toBeNull()
    expect(result[0].agreed_price_cents).toBeNull()
    expect(result[0].pending).toBe('just waiting')
  })

  it('returns empty array for empty section', () => {
    expect(parseActiveNegotiations('')).toEqual([])
  })

  it('ignores subheads that do not start with "Channel"', () => {
    const section = [
      '### Pickup',
      '- Agreed: downtown',
      '### Channel real — @buyer',
      '- Agreed: $40',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result).toHaveLength(1)
    expect(result[0].channel_id).toBe('real')
  })

  it('handles @-prefixed and bare handle in heading', () => {
    const section = [
      '### Channel a — buyer1',
      '- Agreed: $10',
      '### Channel b — @buyer2',
      '- Agreed: $20',
    ].join('\n')

    const result = parseActiveNegotiations(section)

    expect(result[0].counterparty).toBe('@buyer1')
    expect(result[1].counterparty).toBe('@buyer2')
  })
})

// ─── extractPriceCents ──────────────────────────────────────────────────────

describe('extractPriceCents', () => {
  it('parses plain dollar amount ($120 → 12000)', () => {
    expect(extractPriceCents('$120')).toBe(12000)
  })

  it('parses decimal dollars ($120.50 → 12050)', () => {
    expect(extractPriceCents('$120.50')).toBe(12050)
  })

  it('parses thousands separator ($1,234 → 123400)', () => {
    expect(extractPriceCents('$1,234')).toBe(123400)
  })

  it('parses large thousands with decimals ($1,234.56 → 123456)', () => {
    expect(extractPriceCents('$1,234.56')).toBe(123456)
  })

  it('parses single-digit decimal ($5.5 → 550)', () => {
    expect(extractPriceCents('$5.5')).toBe(550)
  })

  it('extracts price embedded in free text', () => {
    expect(
      extractPriceCents('Agreed: $85 on pickup Saturday')
    ).toBe(8500)
  })

  it('tolerates whitespace between $ and digits', () => {
    expect(extractPriceCents('$ 42')).toBe(4200)
  })

  it('returns the first match when multiple amounts appear', () => {
    // Behavior contract: first regex match wins.
    expect(extractPriceCents('$10 down, $90 on pickup')).toBe(1000)
  })

  it('returns null when no dollar amount present', () => {
    expect(extractPriceCents('pickup Saturday')).toBeNull()
  })

  it('returns null on empty string', () => {
    expect(extractPriceCents('')).toBeNull()
  })

  it('returns null when $ has no following digits', () => {
    expect(extractPriceCents('cost is $ and unknown')).toBeNull()
  })

  it('rounds half-cent values to nearest cent', () => {
    // $0.005 rounds to 1 cent (Math.round banker semantics avoided — JS rounds .5 up)
    expect(extractPriceCents('$0.01')).toBe(1)
  })

  it('handles zero correctly ($0 → 0)', () => {
    expect(extractPriceCents('$0')).toBe(0)
  })
})
