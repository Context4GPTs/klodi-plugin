/**
 * Local-only tool registry.
 *
 * `klodiTools` (in `index.ts`) catalogues the request/reply tools — each
 * one is a 1:1 wrapper over a NATS subject the marketplace listens on.
 * The tools registered here are different: they have local side
 * effects (disk writes, browser polling, JetStream publish, multi-call
 * composition) and don't fit the request/reply shape.
 *
 * Per **D § D4** in
 * `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`
 * (reframed: P3-1 + P2-26 + P3-2 + P3-3 + catalog-design): tools live in
 * the catalog or they don't exist. Each adapter's CI gate
 * (`klodi-plugin/scripts/check-adapter-tools.sh`) walks its `registerTool`
 * call sites and asserts the registered set equals
 * `forHostShape(hostShape)`. A name not in the catalog (`klodi_pending`,
 * `klodi_search` singular, `klodi_channel_send`) fails the gate; a name
 * declared `host_shapes: ["in_agent"]` but not registered also fails.
 *
 * `host_shape` declares which adapter shapes must implement the tool:
 *   - `"in_agent"` — OpenClaw (TS), Hermes + nanobot (Py).
 *   - `"daemon"` — Moltis, IronClaw, ZeroClaw (Rust). No in-agent tool
 *     surface today; declared so the gate vacuously passes.
 *   - `"cli_only"` — operations exposed via daemon CLI subcommand only.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Cents, Currency, Iso8601, Uuid } from "./schemas.js";

/** Adapter shapes the catalog distinguishes. */
export const HOST_SHAPES = ["in_agent", "daemon", "cli_only"] as const;
export type HostShape = (typeof HOST_SHAPES)[number];

export type LocalToolKind = "local" | "publish";

export interface LocalToolEntry<
  P extends TSchema = TSchema,
  R extends TSchema = TSchema,
> {
  /** Public tool name (the name agents call). */
  name: string;
  description: string;
  params: P;
  result: R;
  /** Distinguishes pure-local (no NATS) from publish (sends a JetStream message). */
  kind: LocalToolKind;
  /** Adapter shapes that must register this tool. */
  host_shapes: readonly HostShape[];
}

// ─── Common fragments ─────────────────────────────────────────────────

const RegisterPollOutcome = Type.Object({
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("registered"),
    Type.Literal("expired"),
    Type.Literal("error"),
  ]),
  user_id: Type.Optional(Uuid),
  handle: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

/**
 * The standing-search slug a match-feedback verdict belongs to. Mirrors the
 * sibling marketplace's `MatchFeedback.search_slug` pattern
 * (`4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts`) — NOT a
 * UUID. The id rides in the publish *body*, not a subject path, so it carries
 * the slug pattern rather than the strict `Uuid` descriptor (which the
 * channel-message subject-injection guard needs).
 */
const MatchFeedbackSlug = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,119}$",
  description: "The standing-search slug the match belongs to.",
});

/**
 * The matched listing id. The marketplace re-reads the Listing row as the
 * real existence/ownership gate, so the wire only pins a bounded non-empty
 * string (1..64) — deliberately NOT a UUID format. A non-UUID listing id the
 * marketplace accepts must pass this schema too.
 */
const MatchFeedbackListingId = Type.String({
  minLength: 1,
  maxLength: 64,
  description: "The matched listing the verdict is about.",
});

/**
 * The agent's terminal verdict on a surfaced match — the closed set the
 * marketplace's `labelForOutcome` accepts. `pursued` → positive training
 * example; `dismissed` → hard-negative. The ± label is derived SERVER-side;
 * the plugin sends only the action it took. A value outside this set is
 * rejected at the tool boundary, never published.
 */
const MatchFeedbackOutcome = Type.Union(
  [Type.Literal("pursued"), Type.Literal("dismissed")],
  { description: "The agent's verdict: pursued or dismissed." },
);

const SetupStatusResult = Type.Object({
  phase: Type.Union([
    Type.Literal("unconfigured"),
    Type.Literal("registering"),
    Type.Literal("ready"),
    Type.Literal("degraded"),
  ]),
  klodi_home: Type.String(),
  user_id: Type.Optional(Uuid),
  handle: Type.Optional(Type.String()),
  issues: Type.Array(
    Type.Object({
      code: Type.String(),
      detail: Type.Optional(Type.String()),
    }),
  ),
});

// ─── Registry ─────────────────────────────────────────────────────────

/**
 * Every local tool. The shape mirrors `klodiTools` in `index.ts` so the
 * CI gate can compare adapter registrations against a single allowlist.
 */
export const LOCAL_TOOLS = {
  klodi_register: {
    name: "klodi_register",
    description:
      "Open the klodi registration browser flow. Returns a session_id"
      + " the agent polls via klodi_register_poll until the user"
      + " completes OAuth.",
    params: Type.Object({}),
    result: Type.Object({
      session_id: Uuid,
      auth_url: Type.String(),
      poll_after_seconds: Type.Integer({ minimum: 1 }),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_register_poll: {
    name: "klodi_register_poll",
    description:
      "Poll a klodi registration session until terminal. Persists nats.creds"
      + " and config.json on success. Returns status + user identity.",
    params: Type.Object({ session_id: Uuid }),
    result: RegisterPollOutcome,
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_health: {
    name: "klodi_health",
    description:
      "Probe klodi connectivity. Round-trips through users.whoami and"
      + " reports the persistent NATS connection status.",
    params: Type.Object({}),
    result: Type.Object({
      ok: Type.Boolean(),
      connected: Type.Boolean(),
      user_id: Type.Optional(Uuid),
      handle: Type.Optional(Type.String()),
      latency_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      issue: Type.Optional(Type.String()),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_watch: {
    name: "klodi_watch",
    description:
      "Register a standing search and seed the local buy/<slug>.md file."
      + " Composite of klodi_searches_create + filesystem write.",
    params: Type.Object({
      slug: Type.String(),
      query: Type.Optional(Type.String()),
      max_price: Type.Optional(Cents),
      currency: Type.Optional(Currency),
    }),
    result: Type.Object({
      slug: Type.String(),
      search_id: Uuid,
      buy_file_path: Type.String(),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_unwatch: {
    name: "klodi_unwatch",
    description:
      "Stop a standing search and delete the local buy/<slug>.md file."
      + " Composite of the server-side searches.delete + filesystem unlink.",
    params: Type.Object({ slug: Type.String() }),
    result: Type.Object({
      slug: Type.String(),
      removed: Type.Boolean(),
      buy_file_removed: Type.Boolean(),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_setup_status: {
    name: "klodi_setup_status",
    description:
      "Inspect klodi setup state. Reports phase + missing files + user"
      + " identity (when registered). Mostly used by the agent to decide"
      + " whether to run klodi_setup_repair or klodi_register.",
    params: Type.Object({}),
    result: SetupStatusResult,
    kind: "local",
    host_shapes: ["in_agent", "cli_only"],
  },

  klodi_setup_repair: {
    name: "klodi_setup_repair",
    description:
      "Re-seed missing klodi configuration files (skill bundle, policies)."
      + " Idempotent: existing files are preserved; only gaps are filled.",
    params: Type.Object({}),
    result: Type.Object({
      seeded_files: Type.Array(Type.String()),
      preserved_files: Type.Array(Type.String()),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_setup_reseed_policies: {
    name: "klodi_setup_reseed_policies",
    description:
      "Reseed the user's klodi policies (negotiation_style, security)"
      + " from the bundled templates. Never overwrites existing files.",
    params: Type.Object({}),
    result: Type.Object({
      reseeded_files: Type.Array(Type.String()),
      timestamp: Iso8601,
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_setup_reseed_skill: {
    name: "klodi_setup_reseed_skill",
    description:
      "Force-copy the canonical klodi skill bundle from the adapter's"
      + " bundled skill/ tree into ${klodi_home}/skill/. Use after a"
      + " plugin upgrade where the on-disk skill drifted from the new"
      + " plugin version.",
    params: Type.Object({}),
    result: Type.Object({
      reseeded_files: Type.Array(Type.String()),
      timestamp: Iso8601,
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_channel_message: {
    name: "klodi_channel_message",
    description:
      "Publish a message on an open negotiation channel. Direct"
      + " JetStream publish to p2p.v1.channels.<channel_id>.<sender_id>.msg."
      + " The marketplace's side-consumer persists for history-index;"
      + " the recipient's klodi-channels-<recipient_id> consumer wakes them.",
    params: Type.Object({
      channel_id: Uuid,
      content: Type.String({ minLength: 1 }),
    }),
    result: Type.Object({
      sequence: Type.Integer({ minimum: 1 }),
      event_id: Uuid,
      message_id: Uuid,
      created_at: Iso8601,
    }),
    kind: "publish",
    host_shapes: ["in_agent"],
  },

  klodi_match_feedback: {
    name: "klodi_match_feedback",
    description:
      "Report the agent's pursue/dismiss verdict on a standing-search"
      + " match. Direct JetStream publish to p2p.v1.searches.match_feedback;"
      + " the marketplace records it as a training example (SC8 flywheel)."
      + " The wire carries the ACTION (outcome), never a ± label — the label"
      + " is derived server-side. Call exactly once per (search, listing)"
      + " verdict, after evaluating the match against the buy file.",
    params: Type.Object(
      {
        search_slug: MatchFeedbackSlug,
        listing_id: MatchFeedbackListingId,
        outcome: MatchFeedbackOutcome,
        // Provenance: the buy file's action_on_match mode in effect (notify
        // default, or negotiate). Reported honestly so downstream curation can
        // drop a mechanically auto-negotiated pursue. Capped at 40 to mirror
        // the marketplace schema. Omitted from the wire when absent — never null.
        action_on_match: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 40,
            description:
              "The buy file's action_on_match mode in effect (e.g. notify,"
              + " negotiate) — provenance for curation-side filtering.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    result: Type.Object({
      event_id: Uuid,
      sequence: Type.Integer({ minimum: 1 }),
    }),
    kind: "publish",
    host_shapes: ["in_agent"],
  },

  klodi_message_user: {
    name: "klodi_message_user",
    // Mirrors `_MESSAGE_USER_DESCRIPTION` in
    // `adapters/hermes/src/klodi_hermes/message.py` byte-for-byte — the
    // catalog is the cross-language contract, so it must not paraphrase
    // the shipped registration.
    description:
      "Actively reach the human operator from an isolated wake turn — where your"
      + " closing chat text reaches no one — when the wake cannot be resolved"
      + " autonomously and needs the operator's decision or input: a decision"
      + " reserved for them by policy (negotiation_style.md `Always Ask Me First` /"
      + " `Escalation When Unknown`, or a security.md hard rule), a live"
      + " counterparty left waiting, or an inbound you declined to act on. Being"
      + " unsure or stuck is a decision for the human, not an informational note."
      + " Delivers a real-time, self-contained message into the operator's live"
      + " session and records a pending-decision so their reply drives the right"
      + " action. Do NOT ping for decisions the policy authorizes you to handle"
      + " alone, nor for a purely-informational status wake where no counterparty"
      + " is waiting and no decision is open.",
    // Host-local delivery (turn-less send + disk persist), NOT a NATS
    // publish — but a first-class catalog tool all the same (D4).
    params: Type.Object(
      {
        text: Type.String({
          minLength: 1,
          description:
            "The self-contained message to the operator — name the listing /"
            + " counterparty, the question, and the options so a natural-language"
            + " reply is interpretable hours later with no wake context.",
        }),
      },
      { additionalProperties: false },
    ),
    result: Type.Object({
      delivered: Type.Boolean(),
      platform: Type.String(),
      chat_id: Type.String(),
      entity_id: Type.String(),
      pending_status: Type.String(),
    }),
    kind: "local",
    host_shapes: ["in_agent"],
  },

  klodi_pending_decisions: {
    name: "klodi_pending_decisions",
    // Mirrors `_PENDING_DECISIONS_DESCRIPTION` in
    // `adapters/hermes/src/klodi_hermes/pending_decisions.py`.
    description:
      "List the open human-in-the-loop decisions awaiting the operator's"
      + " reply. Scan at the start of every operator turn: when their message"
      + " answers one, re-ground the entity's current state via the klodi read"
      + " tools, act on the bound entity, then the decision is resolved.",
    params: Type.Object({}, { additionalProperties: false }),
    // The FIRST top-level array result in the registry: `handle_pending_decisions`
    // returns `json.dumps([asdict(record) for record in open_pending()])` — a
    // JSON array of PendingDecision records, not an object. The `PendingDecision`
    // dataclass (pending_decisions.py:64-79) is these 8 string fields; `asked_at`
    // is narrowed to `Iso8601` because `_now_iso()` emits `%Y-%m-%dT%H:%M:%SZ`.
    result: Type.Array(
      Type.Object({
        entity_type: Type.String(),
        entity_id: Type.String(),
        event_id: Type.String(),
        question: Type.String(),
        asked_at: Iso8601,
        platform: Type.String(),
        chat_id: Type.String(),
        status: Type.String(),
      }),
    ),
    kind: "local",
    host_shapes: ["in_agent"],
  },
} as const satisfies Record<string, LocalToolEntry>;

export type LocalToolName = keyof typeof LOCAL_TOOLS;

export const LOCAL_TOOL_NAMES: readonly LocalToolName[] = Object.keys(
  LOCAL_TOOLS,
) as LocalToolName[];

/**
 * The set of local-tool names that an adapter with the given shape MUST
 * register. Daemon-only Rust hosts get an empty list — they don't have
 * an in-agent tool surface today.
 *
 * Used by `klodi-plugin/scripts/check-adapter-tools.sh` to compare
 * against each adapter's `registerTool`/`register_tool` call sites.
 */
export function localToolsForHostShape(shape: HostShape): readonly string[] {
  const out: string[] = [];
  for (const entry of Object.values(LOCAL_TOOLS) as LocalToolEntry[]) {
    if (entry.host_shapes.includes(shape)) out.push(entry.name);
  }
  return out;
}

export type LocalToolParams<N extends LocalToolName> = Static<
  (typeof LOCAL_TOOLS)[N]["params"]
>;

export type LocalToolResult<N extends LocalToolName> = Static<
  (typeof LOCAL_TOOLS)[N]["result"]
>;
