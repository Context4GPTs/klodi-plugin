/**
 * klodi_pending: session-start probe — surfaces setup issues AND
 * items requiring user attention.
 *
 * Setup probe uses the cheap filesystem-only subset of
 * lib/setup-state.ts (no NATS whoami round-trip). Whenever the
 * resolved phase is anything but "ready", the response carries
 * `setup_required: true` + the phase code, and the agent hands off
 * to SETUP.md. See skill/SKILL.md §2.1.
 *
 * Pending digest reads every sell/buy markdown file, extracts
 * `## Open Questions` and `## Active Negotiations` sections.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  listSellSlugs,
  listBuySlugs,
  readSellFile,
  readBuyFile,
  type SellFile,
  type BuyFile,
} from "../lib/config.js";
import {
  gatherChecks,
  derivePhase,
  type SetupPhase,
} from "../lib/setup-state.js";
import { jsonResult } from "../lib/tool-result.js";
import {
  extractSection,
  parseOpenQuestions,
  parseActiveNegotiations,
  type OpenQuestion,
  type ActiveNegotiation,
} from "../lib/markdown-sections.js";

interface PendingOpenQuestion extends OpenQuestion {
  slug: string;
  listing_id: string;
}

interface PendingNegotiation extends ActiveNegotiation {
  slug: string;
  /** Null when parsed from a buy file whose prose omits a UUID. */
  listing_id: string | null;
}

export function registerPendingTool(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_pending",
    label: "Pending Items",
    description:
      "Session-start probe. Returns `setup_required` + `setup_phase`"
      + " so the agent can route to SETUP.md when the plugin is not"
      + " ready, plus a digest of open questions and active"
      + " negotiations awaiting user input. Cheap filesystem scan —"
      + " no NATS whoami round-trip. Call first every session.",
    parameters: Type.Object({}),
    async execute() {
      const checks = await gatherChecks(api, { probe: false });
      const setup_phase: SetupPhase = derivePhase(checks);
      const setup_required = setup_phase !== "ready";

      const open_questions: PendingOpenQuestion[] = [];
      const active_negotiations: PendingNegotiation[] = [];

      for (const slug of listSellSlugs()) {
        const sf = readSellFile(slug);
        if (!sf) continue;
        collectFromSell(sf, open_questions, active_negotiations);
      }

      for (const slug of listBuySlugs()) {
        const bf = readBuyFile(slug);
        if (!bf) continue;
        collectFromBuy(bf, active_negotiations);
      }

      return jsonResult({
        setup_required,
        setup_phase,
        open_questions,
        active_negotiations,
      });
    },
  });
}

function collectFromSell(
  sf: SellFile,
  open_questions: PendingOpenQuestion[],
  active_negotiations: PendingNegotiation[],
): void {
  const questionsSection = extractSection(sf.body, "Open Questions");
  for (const q of parseOpenQuestions(questionsSection)) {
    open_questions.push({
      slug: sf.slug,
      listing_id: sf.listing_id,
      ...q,
    });
  }

  const negSection = extractSection(sf.body, "Active Negotiations");
  for (const n of parseActiveNegotiations(negSection)) {
    // Frontmatter listing_id is canonical for sell files — override
    // any parsed `- Listing:` bullet the agent may have written.
    active_negotiations.push({
      ...n,
      slug: sf.slug,
      listing_id: sf.listing_id,
    });
  }
}

function collectFromBuy(
  bf: BuyFile,
  active_negotiations: PendingNegotiation[],
): void {
  const negSection = extractSection(bf.body, "Active Negotiations");
  for (const n of parseActiveNegotiations(negSection)) {
    // Buy-file frontmatter has no listing_id — a buy file is a search,
    // not a specific listing. Per-channel listing_id comes from the
    // `- Listing: <uuid>` bullet parsed into n.listing_id (null when
    // the bullet is absent or contains an unfilled template).
    active_negotiations.push({
      ...n,
      slug: bf.slug,
    });
  }
}
