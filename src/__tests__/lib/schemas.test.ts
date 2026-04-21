/**
 * Tests for src/lib/schemas.ts
 *
 * Validates TypeBox schema constraints using @sinclair/typebox/value.
 * All prices in integer cents. All IDs are UUIDs.
 */

import { describe, it, expect } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import {
  Uuid,
  Cents,
  Category,
  DeliveryMethod,
  Condition,
  Rating,
} from '../../lib/schemas.js'

// ─── Uuid ───────────────────────────────────────────────────────────────────

describe('Uuid', () => {
  it('accepts valid UUID format', () => {
    expect(Value.Check(Uuid, '550e8400-e29b-41d4-a716-446655440000')).toBe(
      true,
    )
    expect(Value.Check(Uuid, '00000000-0000-0000-0000-000000000000')).toBe(
      true,
    )
    expect(Value.Check(Uuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(
      true,
    )
  })

  it('rejects non-UUID strings', () => {
    expect(Value.Check(Uuid, 'not-a-uuid')).toBe(false)
    expect(Value.Check(Uuid, '')).toBe(false)
    expect(Value.Check(Uuid, '550e8400-e29b-41d4-a716')).toBe(false)
    // Uppercase should fail (pattern is lowercase hex only)
    expect(Value.Check(Uuid, '550E8400-E29B-41D4-A716-446655440000')).toBe(
      false,
    )
    expect(Value.Check(Uuid, 123)).toBe(false)
  })
})

// ─── Cents ──────────────────────────────────────────────────────────────────

describe('Cents', () => {
  it('accepts non-negative integers', () => {
    expect(Value.Check(Cents, 0)).toBe(true)
    expect(Value.Check(Cents, 1500)).toBe(true)
    expect(Value.Check(Cents, 100000)).toBe(true)
    expect(Value.Check(Cents, 1)).toBe(true)
  })

  it('rejects negative values', () => {
    expect(Value.Check(Cents, -1)).toBe(false)
    expect(Value.Check(Cents, -100)).toBe(false)
  })

  it('rejects non-integer values', () => {
    expect(Value.Check(Cents, 15.5)).toBe(false)
    expect(Value.Check(Cents, 0.01)).toBe(false)
    expect(Value.Check(Cents, 'abc')).toBe(false)
  })
})

// ─── Category ───────────────────────────────────────────────────────────────

describe('Category', () => {
  const ALL_CATEGORIES = [
    'electronics',
    'furniture',
    'vehicles',
    'clothing',
    'home_garden',
    'sports',
    'collectibles',
    'digital_goods',
    'services',
    'free',
    'other',
  ] as const

  it('accepts all valid categories', () => {
    for (const category of ALL_CATEGORIES) {
      expect(
        Value.Check(Category, category),
        `Expected "${category}" to be valid`,
      ).toBe(true)
    }
  })

  it('has exactly 11 categories', () => {
    expect(ALL_CATEGORIES).toHaveLength(11)
  })

  it('rejects invalid category strings', () => {
    expect(Value.Check(Category, 'invalid')).toBe(false)
    expect(Value.Check(Category, '')).toBe(false)
    expect(Value.Check(Category, 'Electronics')).toBe(false)
  })
})

// ─── DeliveryMethod ─────────────────────────────────────────────────────────

describe('DeliveryMethod', () => {
  it('accepts pickup/ship/digital', () => {
    expect(Value.Check(DeliveryMethod, 'pickup')).toBe(true)
    expect(Value.Check(DeliveryMethod, 'ship')).toBe(true)
    expect(Value.Check(DeliveryMethod, 'digital')).toBe(true)
  })

  it('rejects invalid delivery methods', () => {
    expect(Value.Check(DeliveryMethod, 'mail')).toBe(false)
    expect(Value.Check(DeliveryMethod, '')).toBe(false)
    expect(Value.Check(DeliveryMethod, 'Ship')).toBe(false)
  })
})

// ─── Condition ──────────────────────────────────────────────────────────────

describe('Condition', () => {
  const ALL_CONDITIONS = [
    'new_item',
    'like_new',
    'good',
    'fair',
    'poor',
  ] as const

  it('accepts all valid conditions', () => {
    for (const condition of ALL_CONDITIONS) {
      expect(
        Value.Check(Condition, condition),
        `Expected "${condition}" to be valid`,
      ).toBe(true)
    }
  })

  it('rejects invalid conditions', () => {
    expect(Value.Check(Condition, 'excellent')).toBe(false)
    expect(Value.Check(Condition, 'New')).toBe(false)
    expect(Value.Check(Condition, '')).toBe(false)
  })
})

// ─── Rating ─────────────────────────────────────────────────────────────────

describe('Rating', () => {
  it('accepts 1-5', () => {
    for (let r = 1; r <= 5; r++) {
      expect(Value.Check(Rating, r), `Expected ${r} to be valid`).toBe(true)
    }
  })

  it('rejects 0 and 6', () => {
    expect(Value.Check(Rating, 0)).toBe(false)
    expect(Value.Check(Rating, 6)).toBe(false)
  })

  it('rejects non-integer values', () => {
    expect(Value.Check(Rating, 3.5)).toBe(false)
    expect(Value.Check(Rating, 'five')).toBe(false)
  })
})
