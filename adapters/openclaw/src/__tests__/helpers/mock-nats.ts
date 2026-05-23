/**
 * KlodiClient mock for tools tests.
 *
 * Tools resolve the NATS client via `getClient()` from `lib/client.js`
 * (the singleton wrapper around `@klodi/nats-client`). Tests register
 * canned responses keyed on the `klodi_*` tool name (which becomes the
 * subject in production), then `vi.mock("../../lib/client.js")` to
 * route `getClient()` at this fake.
 *
 * Use:
 *   vi.mock("../../lib/client.js", () => import("../helpers/mock-nats.js"));
 *   beforeEach(() => clearNatsResponses());
 *   mockNatsResponse("klodi_listings_create", { ok: true });
 */

import { vi, type Mock } from "vitest";

const responses = new Map<string, unknown>();
const errors = new Map<string, unknown>();

export function mockNatsResponse(toolName: string, response: unknown): void {
  responses.set(toolName, response);
}

export function mockNatsError(toolName: string, err: unknown): void {
  errors.set(toolName, err);
}

export function clearNatsResponses(): void {
  responses.clear();
  errors.clear();
  notificationsLastEventAt = null;
  notificationsInactiveThresholdMs = null;
  connected = true;
}

export interface MockKlodiClient {
  request: Mock;
  connect: Mock;
  close: Mock;
  isConnected: Mock;
  publishChannelMessage: Mock;
  getNotificationsLastEventAt: Mock;
  getNotificationsInactiveThresholdMs: Mock;
  subscribeNotifications: Mock;
  subscribeChannels: Mock;
}

const channelPublishKey = (channelId: string): string =>
  `channel:${channelId}:publish`;

export function mockChannelPublishResponse(
  channelId: string,
  ack: { sequence: number; stream?: string },
): void {
  responses.set(channelPublishKey(channelId), ack);
}

export function mockChannelPublishError(
  channelId: string,
  err: unknown,
): void {
  errors.set(channelPublishKey(channelId), err);
}

let notificationsLastEventAt: Date | null = null;
let notificationsInactiveThresholdMs: number | null = null;

export function setNotificationsLastEventAt(d: Date | null): void {
  notificationsLastEventAt = d;
}

export function setNotificationsInactiveThresholdMs(ms: number | null): void {
  notificationsInactiveThresholdMs = ms;
}

let connected = true;

export function setConnected(value: boolean): void {
  connected = value;
}

export function createMockClient(): MockKlodiClient {
  return {
    request: vi.fn(async (toolName: string) => {
      if (errors.has(toolName)) {
        throw errors.get(toolName);
      }
      if (responses.has(toolName)) {
        return responses.get(toolName);
      }
      throw new Error(`No mock response registered for tool: ${toolName}`);
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn(() => connected),
    publishChannelMessage: vi.fn(
      async (channelId: string, _payload: { content: string }) => {
        const key = channelPublishKey(channelId);
        if (errors.has(key)) {
          throw errors.get(key);
        }
        if (responses.has(key)) {
          return responses.get(key);
        }
        return { sequence: 1, stream: "P2P_CHANNELS" };
      },
    ),
    getNotificationsLastEventAt: vi.fn(() => notificationsLastEventAt),
    getNotificationsInactiveThresholdMs: vi.fn(
      () => notificationsInactiveThresholdMs,
    ),
    // Wake-pump support: pump.start() calls subscribeNotifications +
    // subscribeChannels on the client. Tests don't exercise the
    // delivery path itself, so the stubs return a no-op subscription.
    subscribeNotifications: vi.fn(async () => ({
      stop: vi.fn().mockResolvedValue(undefined),
    })),
    subscribeChannels: vi.fn(async () => ({
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  };
}

const sharedClient = createMockClient();

/**
 * Drop-in for `vi.mock("../../lib/client.js", ...)` — returns the
 * shape of `lib/client.ts` (`getClient`, `connectClient`, `closeClient`,
 * `isClientConnected`, `KlodiRequestError`) wired to the shared mock.
 */
export function getClient(): MockKlodiClient {
  return sharedClient;
}

export async function connectClient(_api?: unknown): Promise<MockKlodiClient> {
  return sharedClient;
}

export async function closeClient(): Promise<void> {
  /* no-op */
}

export function isClientConnected(): boolean {
  return connected;
}

interface ParsedError {
  error: string;
  message?: string;
  details?: unknown;
}

/**
 * Mirrors the production `KlodiRequestError` constructor in
 * `packages/nats-client-ts/src/client.ts`. Tests construct it with an
 * envelope: `new KlodiRequestError({error, message, details})`.
 * See ADR-0011.
 */
export class KlodiRequestError extends Error {
  public readonly code: string;
  public readonly details: unknown;
  constructor(envelope: ParsedError) {
    super(envelope.message ?? envelope.error);
    this.name = "KlodiRequestError";
    this.code = envelope.error;
    this.details = envelope.details;
  }
}
