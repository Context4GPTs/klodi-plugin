/**
 * Tests for src/lib/config.ts
 *
 * Covers: loadConfig, hasCredentials, sell/buy file I/O, frontmatter parsing,
 * findSellFileByListingId, listSellSlugs/listBuySlugs, slugify.
 *
 * Uses real filesystem via createTempHome() -- no mocks for file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createTempHome, type TempHome } from '../helpers/temp-home.js'
import {
  loadConfig,
  hasCredentials,
  writeSellFile,
  readSellFile,
  deleteSellFile,
  writeBuyFile,
  readBuyFile,
  deleteBuyFile,
  findSellFileByListingId,
  listSellSlugs,
  listBuySlugs,
  slugify,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
  isNegotiationStyleFilled,
  getNegotiationStylePath,
  getNegotiationStyleTemplatePath,
  getSecurityPolicyPath,
  getSecurityPolicyTemplatePath,
  getApiUrl,
  setApiUrl,
  getApiUrlSource,
  getKlodiHome,
  setKlodiHome,
  getKlodiHomeSource,
  applyPluginConfigOverrides,
  type KlodiConfig,
  type BuyFile,
  type KlodiPluginConfig,
} from '../../lib/config.js'

const SAMPLE_CONFIG: KlodiConfig = {
  handle: 'testuser',
  user_id: 'abc-123',
  nkey_public: 'NKEY123',
  nats_url: 'nats://localhost:4222',
}

let home: TempHome

beforeEach(() => {
  home = createTempHome()
})

afterEach(() => {
  home.cleanup()
})

// ─── loadConfig ─────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('reads and parses config.json', () => {
    writeFileSync(
      join(home.path, 'config.json'),
      JSON.stringify(SAMPLE_CONFIG),
      'utf-8',
    )

    const config = loadConfig()

    expect(config).toEqual(SAMPLE_CONFIG)
    expect(config.handle).toBe('testuser')
    expect(config.user_id).toBe('abc-123')
    expect(config.nkey_public).toBe('NKEY123')
    expect(config.nats_url).toBe('nats://localhost:4222')
  })

  it('throws when config.json missing', () => {
    expect(() => loadConfig()).toThrow('Not registered')
  })
})

// ─── hasCredentials ─────────────────────────────────────────────────────────

describe('hasCredentials', () => {
  it('returns true when both config.json and nats.creds exist', () => {
    writeFileSync(
      join(home.path, 'config.json'),
      JSON.stringify(SAMPLE_CONFIG),
      'utf-8',
    )
    writeFileSync(join(home.path, 'nats.creds'), 'cred-data', 'utf-8')

    expect(hasCredentials()).toBe(true)
  })

  it('returns false when config.json missing', () => {
    writeFileSync(join(home.path, 'nats.creds'), 'cred-data', 'utf-8')

    expect(hasCredentials()).toBe(false)
  })

  it('returns false when nats.creds missing', () => {
    writeFileSync(
      join(home.path, 'config.json'),
      JSON.stringify(SAMPLE_CONFIG),
      'utf-8',
    )

    expect(hasCredentials()).toBe(false)
  })
})

// ─── sell file I/O ──────────────────────────────────────────────────────────

describe('sell file I/O', () => {
  const sellData = {
    listing_id: '550e8400-e29b-41d4-a716-446655440000',
    min_acceptable_price: 1500,
    auto_reject_below: 800,
    transaction_id: null as string | null,
    check_every: '2h',
    body: '',
  }

  it('writes with correct frontmatter', () => {
    writeSellFile('test-item', sellData)

    const raw = readFileSync(join(home.sellDir, 'test-item.md'), 'utf-8')

    expect(raw).toContain('---')
    expect(raw).toContain('listing_id: 550e8400-e29b-41d4-a716-446655440000')
    expect(raw).toContain('min_acceptable_price: 1500')
    expect(raw).toContain('auto_reject_below: 800')
    expect(raw).toContain('check_every: 2h')
  })

  it('reads and parses frontmatter', () => {
    writeSellFile('test-item', sellData)

    const result = readSellFile('test-item')

    expect(result).not.toBeNull()
    expect(result!.listing_id).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    )
    expect(result!.min_acceptable_price).toBe(1500)
    expect(result!.auto_reject_below).toBe(800)
    expect(result!.check_every).toBe('2h')
    expect(result!.slug).toBe('test-item')
  })

  it('reads body (freeform markdown)', () => {
    const dataWithBody = {
      ...sellData,
      body: 'This is a **great** item.\n\nWith multiple paragraphs.',
    }
    writeSellFile('with-body', dataWithBody)

    const result = readSellFile('with-body')

    expect(result).not.toBeNull()
    expect(result!.body).toContain('This is a **great** item.')
    expect(result!.body).toContain('With multiple paragraphs.')
  })

  it('returns null for nonexistent file', () => {
    expect(readSellFile('does-not-exist')).toBeNull()
  })

  it('deletes file', () => {
    writeSellFile('to-delete', sellData)

    const deleted = deleteSellFile('to-delete')

    expect(deleted).toBe(true)
    expect(readSellFile('to-delete')).toBeNull()
  })

  it('returns false when deleting nonexistent file', () => {
    expect(deleteSellFile('ghost')).toBe(false)
  })
})

// ─── frontmatter parsing ───────────────────────────────────────────────────

describe('frontmatter parsing', () => {
  it('parses null values (auto_reject_below: null)', () => {
    writeSellFile('null-price', {
      listing_id: 'abc-123',
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      check_every: '1h',
      body: '',
    })

    const result = readSellFile('null-price')

    expect(result).not.toBeNull()
    expect(result!.min_acceptable_price).toBeNull()
    expect(result!.auto_reject_below).toBeNull()
  })

  it('parses integer cent values correctly', () => {
    writeSellFile('cents', {
      listing_id: 'def-456',
      min_acceptable_price: 99999,
      auto_reject_below: 50000,
      transaction_id: null,
      check_every: '30m',
      body: '',
    })

    const result = readSellFile('cents')

    expect(result).not.toBeNull()
    expect(result!.min_acceptable_price).toBe(99999)
    expect(typeof result!.min_acceptable_price).toBe('number')
    expect(result!.auto_reject_below).toBe(50000)
    expect(typeof result!.auto_reject_below).toBe('number')
  })
})

// ─── buy file I/O ───────────────────────────────────────────────────────────

describe('buy file I/O', () => {
  const buyData: Omit<BuyFile, 'slug'> = {
    query: 'vintage mechanical keyboard',
    max_price: 25000,
    target_price: 15000,
    delivery_method: 'ship',
    pickup_radius: null as number | null,
    ships_to: null as string | null,
    action_on_match: 'notify',
    check_every: '4h',
    last_checked: null,
    seen_listings: {},
    body: '',
  }

  it('writes with correct frontmatter', () => {
    writeBuyFile('keyboard-hunt', buyData)

    const raw = readFileSync(
      join(home.buyDir, 'keyboard-hunt.md'),
      'utf-8',
    )

    expect(raw).toContain('query: vintage mechanical keyboard')
    expect(raw).toContain('max_price: 25000')
    expect(raw).toContain('target_price: 15000')
    expect(raw).toContain('delivery_method: ship')
    expect(raw).toContain('pickup_radius: null')
    expect(raw).toContain('ships_to: null')
    expect(raw).toContain('action_on_match: notify')
    expect(raw).toContain('check_every: 4h')
    expect(raw).toContain('last_checked: null')
  })

  it('reads all fields', () => {
    writeBuyFile('keyboard-hunt', buyData)

    const result = readBuyFile('keyboard-hunt')

    expect(result).not.toBeNull()
    expect(result!.query).toBe('vintage mechanical keyboard')
    expect(result!.max_price).toBe(25000)
    expect(result!.target_price).toBe(15000)
    expect(result!.delivery_method).toBe('ship')
    expect(result!.pickup_radius).toBeNull()
    expect(result!.ships_to).toBeNull()
    expect(result!.action_on_match).toBe('notify')
    expect(result!.check_every).toBe('4h')
    expect(result!.last_checked).toBeNull()
    expect(result!.slug).toBe('keyboard-hunt')
  })

  it('roundtrips pickup_radius and ships_to as null', () => {
    writeBuyFile('null-fields', buyData)

    const result = readBuyFile('null-fields')

    expect(result).not.toBeNull()
    expect(result!.pickup_radius).toBeNull()
    expect(result!.ships_to).toBeNull()
  })

  it('roundtrips non-null pickup_radius and ships_to', () => {
    const withLocation = {
      ...buyData,
      pickup_radius: 25,
      ships_to: 'US',
    }
    writeBuyFile('with-location', withLocation)

    const result = readBuyFile('with-location')

    expect(result).not.toBeNull()
    expect(result!.pickup_radius).toBe(25)
    expect(result!.ships_to).toBe('US')
  })

  it('handles last_checked as ISO timestamp and null', () => {
    const withTimestamp = {
      ...buyData,
      last_checked: '2026-04-16T10:30:00Z',
    }
    writeBuyFile('with-timestamp', withTimestamp)

    const result = readBuyFile('with-timestamp')
    expect(result).not.toBeNull()
    expect(result!.last_checked).toBe('2026-04-16T10:30:00Z')

    // Null case
    const withNull = { ...buyData, last_checked: null }
    writeBuyFile('with-null', withNull)

    const nullResult = readBuyFile('with-null')
    expect(nullResult).not.toBeNull()
    expect(nullResult!.last_checked).toBeNull()
  })

  it('throws when action_on_match is invalid', () => {
    const path = join(home.buyDir, 'bad-action.md')
    writeFileSync(path, '---\naction_on_match: auto_offer\n---\n', 'utf-8')
    expect(() => readBuyFile('bad-action')).toThrow(
      /Invalid action_on_match.*bad-action.*auto_offer.*notify.*negotiate/,
    )
  })

  // ── seen_listings frontmatter roundtrip ───────────────────────────────────

  it('roundtrips seen_listings as JSON in frontmatter', () => {
    const withSeen = {
      ...buyData,
      seen_listings: { 'lst-abc': 25000, 'lst-def': 55000 },
    }
    writeBuyFile('with-seen', withSeen)

    const raw = readFileSync(
      join(home.buyDir, 'with-seen.md'),
      'utf-8',
    )
    expect(raw).toContain('seen_listings: {"lst-abc":25000,"lst-def":55000}')

    const result = readBuyFile('with-seen')
    expect(result).not.toBeNull()
    expect(result!.seen_listings).toEqual({
      'lst-abc': 25000,
      'lst-def': 55000,
    })
  })

  it('defaults seen_listings to empty object when missing or null', () => {
    // Legacy buy files written before seen_listings existed should read
    // back cleanly with {} so the dedup code treats everything as new
    // on the next tick.
    const pathMissing = join(home.buyDir, 'legacy-missing.md')
    writeFileSync(
      pathMissing,
      '---\nquery: old\naction_on_match: notify\n---\n',
      'utf-8',
    )
    expect(readBuyFile('legacy-missing')!.seen_listings).toEqual({})

    const pathNull = join(home.buyDir, 'legacy-null.md')
    writeFileSync(
      pathNull,
      '---\nquery: old\naction_on_match: notify\nseen_listings: null\n---\n',
      'utf-8',
    )
    expect(readBuyFile('legacy-null')!.seen_listings).toEqual({})
  })

  it('returns empty seen_listings when frontmatter value is malformed JSON', () => {
    // A hand-edited or corrupted frontmatter shouldn't throw — the tick
    // just treats all current matches as NEW.
    const path = join(home.buyDir, 'broken.md')
    writeFileSync(
      path,
      '---\nquery: x\naction_on_match: notify\nseen_listings: {not-json\n---\n',
      'utf-8',
    )
    expect(readBuyFile('broken')!.seen_listings).toEqual({})
  })
})

// ─── findSellFileByListingId ────────────────────────────────────────────────

describe('findSellFileByListingId', () => {
  const makeItem = (slug: string, listingId: string) => {
    writeSellFile(slug, {
      listing_id: listingId,
      min_acceptable_price: 1000,
      auto_reject_below: null,
      transaction_id: null,
      check_every: '2h',
      body: '',
    })
  }

  it('finds sell file matching listing_id', () => {
    makeItem('my-widget', 'id-aaa')

    const result = findSellFileByListingId('id-aaa')

    expect(result).not.toBeNull()
    expect(result!.slug).toBe('my-widget')
    expect(result!.listing_id).toBe('id-aaa')
  })

  it('returns null when no match', () => {
    makeItem('my-widget', 'id-aaa')

    expect(findSellFileByListingId('id-zzz')).toBeNull()
  })

  it('scans multiple files', () => {
    makeItem('widget-a', 'id-aaa')
    makeItem('widget-b', 'id-bbb')
    makeItem('widget-c', 'id-ccc')

    const result = findSellFileByListingId('id-bbb')

    expect(result).not.toBeNull()
    expect(result!.slug).toBe('widget-b')
  })
})

// ─── listSellSlugs / listBuySlugs ──────────────────────────────────────────

describe('listSellSlugs / listBuySlugs', () => {
  it('returns slugs from .md files only', () => {
    writeSellFile('alpha', {
      listing_id: 'a',
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      check_every: '1h',
      body: '',
    })
    writeSellFile('beta', {
      listing_id: 'b',
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      check_every: '1h',
      body: '',
    })
    // Write a non-.md file that should be ignored
    writeFileSync(join(home.sellDir, 'notes.txt'), 'ignore me', 'utf-8')

    const slugs = listSellSlugs()

    expect(slugs).toContain('alpha')
    expect(slugs).toContain('beta')
    expect(slugs).not.toContain('notes')
    expect(slugs).toHaveLength(2)
  })

  it('returns empty array when directory missing', () => {
    // Use a fresh home with no sell dir
    home.cleanup()
    const freshHome = createTempHome()

    // Remove the sell dir to simulate it never being created
    rmSync(freshHome.sellDir, { recursive: true, force: true })

    expect(listSellSlugs()).toEqual([])

    // Also remove buy dir
    rmSync(freshHome.buyDir, { recursive: true, force: true })
    expect(listBuySlugs()).toEqual([])

    freshHome.cleanup()
  })
})

// ─── slugify ────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and replaces non-alnum with dashes, appends listingId suffix', () => {
    // '!' becomes '-' which is then trimmed as trailing dash
    expect(slugify('Hello World!', 'test-id')).toBe('hello-world-test-i')
    expect(slugify('My Item #42', 'test-id')).toBe('my-item-42-test-i')
  })

  it('trims leading/trailing dashes on base, appends suffix', () => {
    expect(slugify('---hello---', 'test-id')).toBe('hello-test-i')
    expect(slugify('  spaces  ', 'test-id')).toBe('spaces-test-i')
  })

  it('truncates base to 53 chars, total slug max 60 chars', () => {
    const longTitle = 'a'.repeat(100)
    const slug = slugify(longTitle, 'test-id')

    // base = 53 chars + '-' + 6 char suffix = 60 max
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug).toBe('a'.repeat(53) + '-test-i')
  })

  it('handles empty title', () => {
    expect(slugify('', 'test-id')).toBe('-test-i')
  })
})

// ─── seedNegotiationStyleIfAbsent ──────────────────────────────────────────

describe('seedNegotiationStyleIfAbsent', () => {
  it('copies the bundled template to the user policies dir when absent', () => {
    const target = getNegotiationStylePath()
    expect(existsSync(target)).toBe(false)

    const copied = seedNegotiationStyleIfAbsent()

    expect(copied).toBe(true)
    expect(existsSync(target)).toBe(true)

    const written = readFileSync(target, 'utf-8')
    const templatePath = getNegotiationStyleTemplatePath()
    const template = readFileSync(templatePath, 'utf-8')
    expect(written).toBe(template)
  })

  it('is idempotent: second call returns false and does not overwrite', () => {
    // First call seeds.
    expect(seedNegotiationStyleIfAbsent()).toBe(true)

    // Mutate the user's file.
    const target = getNegotiationStylePath()
    const customContent = '# My Custom Policy\n\nfirm posture\n'
    writeFileSync(target, customContent, 'utf-8')

    // Second call must NOT overwrite.
    expect(seedNegotiationStyleIfAbsent()).toBe(false)

    const after = readFileSync(target, 'utf-8')
    expect(after).toBe(customContent)
  })

  it('creates the policies dir if it does not exist', () => {
    // Remove the policies dir that createTempHome pre-made.
    rmSync(home.policiesDir, { recursive: true, force: true })
    expect(existsSync(home.policiesDir)).toBe(false)

    const copied = seedNegotiationStyleIfAbsent()

    expect(copied).toBe(true)
    expect(existsSync(home.policiesDir)).toBe(true)
    expect(existsSync(getNegotiationStylePath())).toBe(true)
  })

  it('writes content matching the shipped template verbatim', () => {
    seedNegotiationStyleIfAbsent()

    const written = readFileSync(getNegotiationStylePath(), 'utf-8')

    // Spot-check the template shape: must include the conventional
    // sections the plugin's SKILL.md relies on.
    expect(written).toContain('# Negotiation Style')
    expect(written).toContain('## Posture')
    expect(written).toContain('## Authorization')
    expect(written).toContain('## Always Ask Me First')
    expect(written).toContain('## Escalation When Unknown')
    expect(written).toContain('## Logistics Preferences')
  })
})

// ─── seedSecurityPolicyIfAbsent ────────────────────────────────────────────

describe('seedSecurityPolicyIfAbsent', () => {
  it('copies the bundled security.md to the user policies dir when absent', () => {
    const target = getSecurityPolicyPath()
    expect(existsSync(target)).toBe(false)

    const copied = seedSecurityPolicyIfAbsent()

    expect(copied).toBe(true)
    expect(existsSync(target)).toBe(true)

    const written = readFileSync(target, 'utf-8')
    const template = readFileSync(getSecurityPolicyTemplatePath(), 'utf-8')
    expect(written).toBe(template)
  })

  it('is idempotent', () => {
    expect(seedSecurityPolicyIfAbsent()).toBe(true)
    expect(seedSecurityPolicyIfAbsent()).toBe(false)
  })

  it('writes the hard-rule sections that SKILL.md depends on', () => {
    seedSecurityPolicyIfAbsent()
    const written = readFileSync(getSecurityPolicyPath(), 'utf-8')
    expect(written).toContain('# Security Policies')
    expect(written).toContain('## Price Protection')
    expect(written).toContain('## Credential Safety')
  })
})

// ─── isNegotiationStyleFilled ──────────────────────────────────────────────

describe('isNegotiationStyleFilled', () => {
  it('returns false when the file does not exist', () => {
    expect(isNegotiationStyleFilled()).toBe(false)
  })

  it('returns false for the freshly-seeded template (placeholders intact)', () => {
    seedNegotiationStyleIfAbsent()
    expect(isNegotiationStyleFilled()).toBe(false)
  })

  it('returns false when the Posture sentinel remains', () => {
    writeFileSync(
      getNegotiationStylePath(),
      '# Negotiation Style\n\n## Posture\n\nfirm | flexible | aggressive\n',
      'utf-8',
    )
    expect(isNegotiationStyleFilled()).toBe(false)
  })

  it('returns false when any <e.g., ...> placeholder remains', () => {
    writeFileSync(
      getNegotiationStylePath(),
      '# Negotiation Style\n\n## Posture\n\nfirm\n\n'
        + '## Logistics Preferences\n\n- Areas: <e.g., Williamsburg>\n',
      'utf-8',
    )
    expect(isNegotiationStyleFilled()).toBe(false)
  })

  it('returns true when all placeholders are replaced', () => {
    writeFileSync(
      getNegotiationStylePath(),
      '# Negotiation Style\n\n## Posture\n\nfirm\n\n'
        + '## Logistics Preferences\n\n- Areas: Williamsburg, Brooklyn\n',
      'utf-8',
    )
    expect(isNegotiationStyleFilled()).toBe(true)
  })
})

// ─── getApiUrl / setApiUrl ─────────────────────────────────────────────────

describe('getApiUrl / setApiUrl', () => {
  const DEFAULT_API_URL = 'https://klodi.4gpts.com'
  let savedEnv: string | undefined

  beforeEach(() => {
    // Stash any developer-machine KLODI_API_URL so test state is deterministic.
    savedEnv = process.env['KLODI_API_URL']
    delete process.env['KLODI_API_URL']
    // Reset the module-level override so each test starts clean.
    setApiUrl('')
  })

  afterEach(() => {
    // Restore both the module-level override and the env var.
    setApiUrl('')
    if (savedEnv === undefined) {
      delete process.env['KLODI_API_URL']
    } else {
      process.env['KLODI_API_URL'] = savedEnv
    }
  })

  it('returns built-in default when env var and override are both absent', () => {
    expect(getApiUrl()).toBe(DEFAULT_API_URL)
  })

  it('returns KLODI_API_URL env var when override is not set', () => {
    process.env['KLODI_API_URL'] = 'https://api.staging.example.com'

    expect(getApiUrl()).toBe('https://api.staging.example.com')
  })

  it('override wins over env var when both are set', () => {
    process.env['KLODI_API_URL'] = 'https://api.staging.example.com'
    setApiUrl('https://api.override.example.com')

    expect(getApiUrl()).toBe('https://api.override.example.com')
  })

  it('override wins over default when env var is unset', () => {
    setApiUrl('https://api.override.example.com')

    expect(getApiUrl()).toBe('https://api.override.example.com')
  })

  it('setApiUrl("") clears override so env var is restored', () => {
    process.env['KLODI_API_URL'] = 'https://api.env.example.com'
    setApiUrl('https://api.override.example.com')
    expect(getApiUrl()).toBe('https://api.override.example.com')

    setApiUrl('')

    expect(getApiUrl()).toBe('https://api.env.example.com')
  })

  it('setApiUrl("") clears override so default is restored when env var absent', () => {
    setApiUrl('https://api.override.example.com')
    expect(getApiUrl()).toBe('https://api.override.example.com')

    setApiUrl('')

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
  })

  it('empty string passed to setApiUrl never produces an empty URL from getApiUrl', () => {
    setApiUrl('')

    // Must never return '' — empty override must fall through the chain.
    expect(getApiUrl()).not.toBe('')
    expect(getApiUrl()).toBe(DEFAULT_API_URL)

    process.env['KLODI_API_URL'] = 'https://api.env.example.com'
    setApiUrl('')
    expect(getApiUrl()).not.toBe('')
    expect(getApiUrl()).toBe('https://api.env.example.com')
  })

  it('setApiUrl replaces a previous override (last call wins)', () => {
    setApiUrl('https://api.first.example.com')
    setApiUrl('https://api.second.example.com')

    expect(getApiUrl()).toBe('https://api.second.example.com')
  })
})

// ─── applyPluginConfigOverrides ────────────────────────────────────────────

describe('applyPluginConfigOverrides', () => {
  const DEFAULT_API_URL = 'https://klodi.4gpts.com'
  const DEFAULT_KLODI_HOME = join(
    homedir(),
    '.openclaw',
    'workspace',
    '.klodi',
  )

  let savedApiUrlEnv: string | undefined
  let savedKlodiHomeEnv: string | undefined

  beforeEach(() => {
    // Stash any developer-machine env vars so test state is deterministic.
    savedApiUrlEnv = process.env['KLODI_API_URL']
    savedKlodiHomeEnv = process.env['KLODI_HOME']
    delete process.env['KLODI_API_URL']
    delete process.env['KLODI_HOME']

    // Outer beforeEach (createTempHome) already set _klodiHome. Reset both
    // module-level overrides so each test starts with source = "default".
    setApiUrl('')
    setKlodiHome('')
  })

  afterEach(() => {
    setApiUrl('')
    setKlodiHome('')
    if (savedApiUrlEnv === undefined) {
      delete process.env['KLODI_API_URL']
    } else {
      process.env['KLODI_API_URL'] = savedApiUrlEnv
    }
    if (savedKlodiHomeEnv === undefined) {
      delete process.env['KLODI_HOME']
    } else {
      process.env['KLODI_HOME'] = savedKlodiHomeEnv
    }
  })

  it('undefined argument is a no-op — apiUrl and klodiHome remain at default', () => {
    applyPluginConfigOverrides(undefined)

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
    expect(getApiUrlSource()).toBe('default')
    expect(getKlodiHome()).toBe(DEFAULT_KLODI_HOME)
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('empty object is a no-op', () => {
    applyPluginConfigOverrides({})

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
    expect(getApiUrlSource()).toBe('default')
    expect(getKlodiHome()).toBe(DEFAULT_KLODI_HOME)
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('sets apiUrl from klodi_api_url and marks source as "config"', () => {
    applyPluginConfigOverrides({
      klodi_api_url: 'http://host.docker.internal:3000',
    })

    expect(getApiUrl()).toBe('http://host.docker.internal:3000')
    expect(getApiUrlSource()).toBe('config')
  })

  it('sets klodiHome from klodi_home and marks source as "config"', () => {
    applyPluginConfigOverrides({ klodi_home: '/tmp/k' })

    expect(getKlodiHome()).toBe('/tmp/k')
    expect(getKlodiHomeSource()).toBe('config')
  })

  it('applies both klodi_api_url and klodi_home when both are set', () => {
    applyPluginConfigOverrides({
      klodi_api_url: 'http://localhost:4000',
      klodi_home: '/tmp/kk',
    })

    expect(getApiUrl()).toBe('http://localhost:4000')
    expect(getApiUrlSource()).toBe('config')
    expect(getKlodiHome()).toBe('/tmp/kk')
    expect(getKlodiHomeSource()).toBe('config')
  })

  it('ignores empty-string klodi_api_url — does not override', () => {
    applyPluginConfigOverrides({ klodi_api_url: '' })

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
    expect(getApiUrlSource()).toBe('default')
  })

  it('ignores empty-string klodi_home — does not override', () => {
    applyPluginConfigOverrides({ klodi_home: '' })

    expect(getKlodiHome()).toBe(DEFAULT_KLODI_HOME)
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('ignores non-string klodi_api_url (number) — does not override', () => {
    // double-cast is intentional — this test verifies the runtime narrowing for invalid JSON shapes
    applyPluginConfigOverrides(
      { klodi_api_url: 42 } as unknown as KlodiPluginConfig,
    )

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
    expect(getApiUrlSource()).toBe('default')
  })

  it('ignores non-string klodi_home (boolean) — does not override', () => {
    // double-cast is intentional — this test verifies the runtime narrowing for invalid JSON shapes
    applyPluginConfigOverrides(
      { klodi_home: true } as unknown as KlodiPluginConfig,
    )

    expect(getKlodiHome()).toBe(DEFAULT_KLODI_HOME)
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('ignores null values for either key', () => {
    // double-cast is intentional — this test verifies the runtime narrowing for invalid JSON shapes
    applyPluginConfigOverrides(
      { klodi_api_url: null, klodi_home: null } as unknown as KlodiPluginConfig,
    )

    expect(getApiUrl()).toBe(DEFAULT_API_URL)
    expect(getApiUrlSource()).toBe('default')
    expect(getKlodiHome()).toBe(DEFAULT_KLODI_HOME)
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('pluginConfig override wins over KLODI_API_URL env var', () => {
    process.env['KLODI_API_URL'] = 'https://env.example.com'

    applyPluginConfigOverrides({
      klodi_api_url: 'https://override.example.com',
    })

    expect(getApiUrl()).toBe('https://override.example.com')
    expect(getApiUrlSource()).toBe('config')
  })

  it('pluginConfig override wins over KLODI_HOME env var', () => {
    process.env['KLODI_HOME'] = '/from/env'

    applyPluginConfigOverrides({ klodi_home: '/from/config' })

    expect(getKlodiHome()).toBe('/from/config')
    expect(getKlodiHomeSource()).toBe('config')
  })

  it('calling apply twice with different values — last call wins (apiUrl)', () => {
    applyPluginConfigOverrides({ klodi_api_url: 'https://first.example.com' })
    applyPluginConfigOverrides({ klodi_api_url: 'https://second.example.com' })

    expect(getApiUrl()).toBe('https://second.example.com')
    expect(getApiUrlSource()).toBe('config')
  })

  it('calling apply twice with different values — last call wins (klodiHome)', () => {
    applyPluginConfigOverrides({ klodi_home: '/tmp/first' })
    applyPluginConfigOverrides({ klodi_home: '/tmp/second' })

    expect(getKlodiHome()).toBe('/tmp/second')
    expect(getKlodiHomeSource()).toBe('config')
  })

  it('second apply with empty/missing value does NOT clear a previously-set override', () => {
    applyPluginConfigOverrides({ klodi_api_url: 'https://first.example.com' })
    // Empty string is ignored by applyPluginConfigOverrides (length > 0 gate).
    applyPluginConfigOverrides({ klodi_api_url: '' })

    expect(getApiUrl()).toBe('https://first.example.com')
    expect(getApiUrlSource()).toBe('config')
  })
})

// ─── getApiUrlSource ───────────────────────────────────────────────────────

describe('getApiUrlSource', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env['KLODI_API_URL']
    delete process.env['KLODI_API_URL']
    setApiUrl('')
  })

  afterEach(() => {
    setApiUrl('')
    if (savedEnv === undefined) {
      delete process.env['KLODI_API_URL']
    } else {
      process.env['KLODI_API_URL'] = savedEnv
    }
  })

  it('returns "default" when neither override nor env var is set', () => {
    expect(getApiUrlSource()).toBe('default')
  })

  it('returns "env" when only KLODI_API_URL env var is set', () => {
    process.env['KLODI_API_URL'] = 'https://env.example.com'

    expect(getApiUrlSource()).toBe('env')
  })

  it('returns "config" when setApiUrl was called with a non-empty value', () => {
    setApiUrl('https://override.example.com')

    expect(getApiUrlSource()).toBe('config')
  })

  it('returns "config" even when both override and env var are set', () => {
    process.env['KLODI_API_URL'] = 'https://env.example.com'
    setApiUrl('https://override.example.com')

    expect(getApiUrlSource()).toBe('config')
  })

  it('setApiUrl("") clears the override — falls back to "env" if env var is set', () => {
    process.env['KLODI_API_URL'] = 'https://env.example.com'
    setApiUrl('https://override.example.com')
    expect(getApiUrlSource()).toBe('config')

    setApiUrl('')

    expect(getApiUrlSource()).toBe('env')
  })

  it('setApiUrl("") clears the override — falls back to "default" when no env var', () => {
    setApiUrl('https://override.example.com')
    expect(getApiUrlSource()).toBe('config')

    setApiUrl('')

    expect(getApiUrlSource()).toBe('default')
  })
})

// ─── getKlodiHomeSource ────────────────────────────────────────────────────

describe('getKlodiHomeSource', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env['KLODI_HOME']
    delete process.env['KLODI_HOME']
    // Outer beforeEach ran createTempHome() which called setKlodiHome(path).
    // Reset so tests start with source = "default".
    setKlodiHome('')
  })

  afterEach(() => {
    setKlodiHome('')
    if (savedEnv === undefined) {
      delete process.env['KLODI_HOME']
    } else {
      process.env['KLODI_HOME'] = savedEnv
    }
  })

  it('returns "default" when neither override nor env var is set', () => {
    expect(getKlodiHomeSource()).toBe('default')
  })

  it('returns "env" when only KLODI_HOME env var is set', () => {
    process.env['KLODI_HOME'] = '/tmp/from-env'

    expect(getKlodiHomeSource()).toBe('env')
  })

  it('returns "config" when setKlodiHome was called with a non-empty value', () => {
    setKlodiHome('/tmp/from-config')

    expect(getKlodiHomeSource()).toBe('config')
  })

  it('returns "config" even when both override and env var are set', () => {
    process.env['KLODI_HOME'] = '/tmp/from-env'
    setKlodiHome('/tmp/from-config')

    expect(getKlodiHomeSource()).toBe('config')
  })

  it('setKlodiHome("") clears the override — falls back to "env" if env var is set', () => {
    process.env['KLODI_HOME'] = '/tmp/from-env'
    setKlodiHome('/tmp/from-config')
    expect(getKlodiHomeSource()).toBe('config')

    setKlodiHome('')

    expect(getKlodiHomeSource()).toBe('env')
  })

  it('setKlodiHome("") clears the override — falls back to "default" when no env var', () => {
    setKlodiHome('/tmp/from-config')
    expect(getKlodiHomeSource()).toBe('config')

    setKlodiHome('')

    expect(getKlodiHomeSource()).toBe('default')
  })
})
