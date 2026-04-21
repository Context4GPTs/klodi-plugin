/**
 * Tests for src/lib/tool-result.ts
 *
 * Covers: jsonResult, errorResult, handleResponse.
 * These are pure functions -- no I/O, no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import {
  jsonResult,
  errorResult,
  handleResponse,
} from '../../lib/tool-result.js'

// ─── jsonResult ─────────────────────────────────────────────────────────────

describe('jsonResult', () => {
  it('wraps data in text content with JSON formatting', () => {
    const data = { id: 'abc', price: 1500, active: true }
    const result = jsonResult(data)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2))
    expect(result.isError).toBeUndefined()
  })

  it('handles arrays', () => {
    const data = [1, 2, 3]
    const result = jsonResult(data)

    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2))
  })

  it('handles null and primitives', () => {
    expect(jsonResult(null).content[0].text).toBe('null')
    expect(jsonResult('hello').content[0].text).toBe('"hello"')
    expect(jsonResult(42).content[0].text).toBe('42')
  })
})

// ─── errorResult ────────────────────────────────────────────────────────────

describe('errorResult', () => {
  it('returns isError: true with message', () => {
    const result = errorResult('Something went wrong')

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('Something went wrong')
    expect(result.isError).toBe(true)
  })

  it('preserves exact message string', () => {
    const msg = 'NOT_FOUND: Listing abc-123 does not exist'
    const result = errorResult(msg)

    expect(result.content[0].text).toBe(msg)
  })
})

// ─── handleResponse ─────────────────────────────────────────────────────────

describe('handleResponse', () => {
  it('returns error result when response has error field', () => {
    const response = {
      error: 'NOT_FOUND',
      message: 'Listing does not exist',
    }
    const result = handleResponse(response)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      'NOT_FOUND: Listing does not exist',
    )
  })

  it('uses error code as message when message field missing', () => {
    const response = { error: 'INTERNAL_ERROR' }
    const result = handleResponse(response)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('INTERNAL_ERROR: INTERNAL_ERROR')
  })

  it('returns JSON result when response is clean', () => {
    const response = {
      id: '123',
      title: 'Widget',
      price: 1500,
    }
    const result = handleResponse(response)

    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe('text')

    const parsed = JSON.parse(result.content[0].text!)
    expect(parsed.id).toBe('123')
    expect(parsed.title).toBe('Widget')
    expect(parsed.price).toBe(1500)
  })
})
