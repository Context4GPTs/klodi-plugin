/**
 * Mock NATS client factory for testing tools that make NATS requests.
 * Register canned responses by subject, then verify request calls.
 */

import { vi, type Mock } from 'vitest'

const responses = new Map<string, unknown>()

/** Register a canned response for a NATS subject. */
export function mockNatsResponse(subject: string, response: unknown): void {
  responses.set(subject, response)
}

/** Clear all registered NATS mock responses. */
export function clearNatsResponses(): void {
  responses.clear()
}

export interface MockNatsClient {
  request: Mock
  getConnection: Mock
  isConnected: Mock
  drain: Mock
}

/** Create a mock matching the nats-client.ts export shape. */
export function createNatsClientMock(): MockNatsClient {
  return {
    request: vi.fn(async (subject: string) => {
      const r = responses.get(subject)
      if (r === undefined) {
        throw new Error(`No mock response for NATS subject: ${subject}`)
      }
      return r
    }),

    getConnection: vi.fn().mockResolvedValue({
      isClosed: () => false,
      jetstream: vi.fn(),
      status: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      })),
      drain: vi.fn(),
    }),

    isConnected: vi.fn().mockReturnValue(true),

    drain: vi.fn().mockResolvedValue(undefined),
  }
}
