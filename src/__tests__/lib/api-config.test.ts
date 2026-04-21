/**
 * Tests for src/lib/api-config.ts
 *
 * Covers: readApiConfig — a SDK-compat bridge that unifies the two
 * shapes of api.config seen across OpenClaw releases:
 *   1. Delegate:   api.config.get(key)      (older releases)
 *   2. Plain tree: api.config.agents.heart… (newer releases)
 *
 * Pure function over the PluginAPI interface — no mocks, no I/O.
 * Tests construct hand-rolled APIs via `as unknown as PluginAPI`
 * because we deliberately exercise shapes the strict d.ts doesn't
 * enumerate — that's the whole point of the helper.
 */

import { describe, it, expect, vi } from 'vitest'
import type { PluginAPI } from 'openclaw/plugin-sdk'
import { readApiConfig } from '../../lib/api-config.js'

function makeApi(config: unknown): PluginAPI {
  return { config } as unknown as PluginAPI
}

// ─── Delegate path (api.config.get is a function) ───────────────────────────

describe('readApiConfig — delegate path', () => {
  it('returns the value the delegate returns', () => {
    const api = makeApi({
      get: vi.fn((key: string) =>
        key === 'heartbeat.target' ? 'last' : undefined,
      ),
    })

    expect(readApiConfig(api, 'heartbeat.target')).toBe('last')
  })

  it('forwards the key verbatim — does NOT split on dots', () => {
    // The delegate decides how to interpret the key. We must NOT
    // pre-split — the older SDK contract was "give us the whole key,
    // we handle namespacing internally."
    const get = vi.fn().mockReturnValue('sentinel')
    const api = makeApi({ get })

    readApiConfig(api, 'agents.defaults.heartbeat.target')

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('agents.defaults.heartbeat.target')
  })

  it('returns undefined when the delegate returns undefined', () => {
    const api = makeApi({ get: vi.fn().mockReturnValue(undefined) })
    expect(readApiConfig(api, 'missing.key')).toBeUndefined()
  })

  it('binds `this` to api.config in the delegate path', () => {
    // Prove the binding: the `get` implementation reads a private
    // field on its own `this`. A broken implementation that calls
    // `maybeGet(key)` instead of `maybeGet.call(api.config, key)`
    // would fail to see `_store` and return undefined.
    const configObject = {
      _store: { token: 'secret-value' } as Record<string, string>,
      get(this: { _store: Record<string, string> }, key: string): unknown {
        return this._store[key]
      },
    }
    const api = makeApi(configObject)

    expect(readApiConfig(api, 'token')).toBe('secret-value')
  })
})

// ─── Plain-object walk path (.get is absent or not a function) ─────────────

describe('readApiConfig — plain-object walk', () => {
  it('returns a single-level value', () => {
    const api = makeApi({ klodi_home: '/tmp/klodi' })
    expect(readApiConfig(api, 'klodi_home')).toBe('/tmp/klodi')
  })

  it('walks a dotted key across nested objects', () => {
    const api = makeApi({
      agents: {
        defaults: {
          heartbeat: { target: 'last' },
        },
      },
    })

    expect(
      readApiConfig(api, 'agents.defaults.heartbeat.target'),
    ).toBe('last')
  })

  it('returns undefined when the leaf is missing', () => {
    const api = makeApi({ agents: { defaults: {} } })
    expect(
      readApiConfig(api, 'agents.defaults.heartbeat.target'),
    ).toBeUndefined()
  })

  it('returns undefined when an intermediate key is missing', () => {
    const api = makeApi({ agents: {} })
    expect(
      readApiConfig(api, 'agents.defaults.heartbeat.target'),
    ).toBeUndefined()
  })

  it('returns undefined when an intermediate value is null', () => {
    const api = makeApi({ agents: { defaults: null } })
    expect(
      readApiConfig(api, 'agents.defaults.heartbeat.target'),
    ).toBeUndefined()
  })

  it('returns undefined when an intermediate value is a primitive string', () => {
    // A string is not indexable as a config tree; must not walk
    // character-by-character or confuse a string for an object.
    const api = makeApi({ agents: 'unexpected-string' })
    expect(
      readApiConfig(api, 'agents.defaults.heartbeat.target'),
    ).toBeUndefined()
  })

  it('returns undefined when an intermediate value is a primitive number', () => {
    const api = makeApi({ agents: 42 })
    expect(
      readApiConfig(api, 'agents.defaults'),
    ).toBeUndefined()
  })

  it('returns undefined when api.config itself is undefined', () => {
    const api = makeApi(undefined)
    expect(readApiConfig(api, 'anything')).toBeUndefined()
  })

  it('returns undefined when api.config itself is null', () => {
    const api = makeApi(null)
    expect(readApiConfig(api, 'anything')).toBeUndefined()
  })

  it('returns undefined for an empty key — splits to [""]', () => {
    // "".split(".") === [""], so we look up the "" property which
    // is never set on a real config tree. Must return undefined
    // (not the whole config object).
    const api = makeApi({ heartbeat: { target: 'last' } })
    expect(readApiConfig(api, '')).toBeUndefined()
  })

  it('falls through to walk when .get is present but not a function', () => {
    // Real-world SDK drift: a config object may accidentally ship
    // with `get: "not-a-fn"` (some user copied a JSON sample as-is).
    // The helper must ignore the non-function and walk normally.
    const api = makeApi({
      get: 'not-a-fn',
      real: { value: 7 },
    })

    expect(readApiConfig(api, 'real.value')).toBe(7)
  })

  it('returns a boolean leaf value unchanged', () => {
    const api = makeApi({ flags: { enabled: true } })
    expect(readApiConfig(api, 'flags.enabled')).toBe(true)
  })

  it('returns a numeric leaf value unchanged', () => {
    const api = makeApi({ retries: 3 })
    expect(readApiConfig(api, 'retries')).toBe(3)
  })

  it('returns null when the leaf is explicitly null', () => {
    const api = makeApi({ heartbeat: { target: null } })
    expect(readApiConfig(api, 'heartbeat.target')).toBeNull()
  })
})
