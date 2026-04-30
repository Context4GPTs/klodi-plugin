/**
 * Synthetic publisher helper — Decision 5, D.1.ts.
 *
 * Connects to NATS over WebSocket using the service-account creds
 * (broad publish allow), publishes a fully-formed NotificationEvent or
 * ChannelMessageEvent on a per-test subject, returns the JetStream ack.
 *
 * The KlodiClient under test connects via WebSocket on the user-scoped
 * creds. Keeping the publisher on a separate connection / cred set
 * avoids mixing send and receive identity, and matches the production
 * topology (marketplace publishes via service identity → P2P_*).
 */
import {
  credsAuthenticator,
  wsconnect,
  type NatsConnection,
} from "@nats-io/nats-core";
import { jetstream } from "@nats-io/jetstream";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket as NodeWebSocket } from "ws";

const encoder = new TextEncoder();

export interface SyntheticPublisher {
  publishNotification(args: {
    userId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<{ event_id: string; sequence: number }>;
  close(): Promise<void>;
}

export async function makeSyntheticPublisher(args: {
  natsUrl: string;
  credsPath: string;
}): Promise<SyntheticPublisher> {
  const creds = readFileSync(args.credsPath);
  // Match production transport: nats-core v3 ships only WS in the core
  // package; the Node TCP transport lives in a separate package we don't
  // depend on. Re-using `wsconnect` + ws-package wsFactory mirrors
  // src/client.ts so tests exercise the same surface as production.
  const nc: NatsConnection = await wsconnect({
    servers: args.natsUrl,
    authenticator: credsAuthenticator(creds),
    wsFactory: (url: string) => Promise.resolve({
      socket: new NodeWebSocket(url) as unknown as WebSocket,
      encrypted: url.startsWith("wss://"),
    }),
  });
  const js = jetstream(nc);

  return {
    async publishNotification(opts) {
      const eventId = randomUUID();
      const body = {
        event_id: eventId,
        kind: opts.kind,
        ...opts.payload,
      };
      const ack = await js.publish(
        `p2p.v1.notifications.${opts.userId}`,
        encoder.encode(JSON.stringify(body)),
        { msgID: eventId },
      );
      return { event_id: eventId, sequence: ack.seq };
    },
    async close(): Promise<void> {
      await nc.drain();
    },
  };
}

// qa-developer: 0012-gap-fixes-decision-13
