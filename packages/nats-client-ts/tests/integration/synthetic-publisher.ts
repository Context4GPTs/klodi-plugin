/**
 * Synthetic publisher helper — Decision 5, D.1.ts.
 *
 * Re-homed off `ws://localhost` onto the surviving `tls://` raw-TCP
 * transport (card: remove-dead-ws-localhost-nats-transport-bypass). The
 * `ws://localhost` WebSocket transport + the `ws` package are deleted, so
 * this helper now mirrors `src/client.ts`'s `connectTcp` exactly: the Node
 * TCP transport from `@nats-io/transport-node` with the private dev CA
 * trusted (cert + hostname verification ON — `rejectUnauthorized` never
 * disabled).
 *
 * Connects to NATS over `tls://` using the service-account creds (broad
 * publish allow), publishes a fully-formed NotificationEvent on a per-test
 * subject, returns the JetStream ack. The KlodiClient under test connects
 * over the same `tls://` transport on the user-scoped creds — keeping the
 * publisher on a separate connection / cred set avoids mixing send and
 * receive identity, and matches the production topology (marketplace
 * publishes via service identity → P2P_*).
 */
import { credsAuthenticator, type NatsConnection } from "@nats-io/nats-core";
import { connect as nodeConnect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
  /** A `tls://` URL — the surviving transport (dev-CA loopback in tests). */
  natsUrl: string;
  credsPath: string;
  /** PEM path for the private dev CA that signs the local tls:// nats.
   *  Defaults to `KLODI_NATS_CA_FILE` — the same env the client resolves. */
  caFile?: string;
}): Promise<SyntheticPublisher> {
  const creds = readFileSync(args.credsPath);
  const caPath = args.caFile ?? process.env["KLODI_NATS_CA_FILE"] ?? "";
  // Mirror src/client.ts connectTcp: raw TCP + TLS trusting only the private
  // dev CA, verification always ON. No `ws`/`wsconnect`/`wsFactory` anywhere.
  const nc: NatsConnection = await nodeConnect({
    servers: args.natsUrl,
    authenticator: credsAuthenticator(creds),
    tls: caPath !== "" ? { ca: readFileSync(caPath) } : undefined,
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

// qa-developer: remove-dead-ws-localhost-nats-transport-bypass
