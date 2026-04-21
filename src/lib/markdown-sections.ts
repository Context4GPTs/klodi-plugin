/**
 * Parse conventional sections from sell/buy markdown bodies.
 *
 * The body sections are agent-authored prose. These helpers are
 * intentionally tolerant to imperfect formatting (extra whitespace,
 * missing comment lines, nested bullets).
 *
 * Called by `klodi_pending` to surface items requiring user attention.
 */

export interface OpenQuestion {
  asker: string;
  asked_on: string;
  question: string;
}

export interface ActiveNegotiation {
  channel_id: string;
  counterparty: string;
  /**
   * UUID parsed from a `- Listing: <uuid>` bullet in the channel block.
   * Populated for buy-file negotiations where each channel targets a
   * specific listing. Null for sell-file negotiations (frontmatter
   * already carries the id) or when the bullet is absent.
   */
  listing_id: string | null;
  agreed_price_cents: number | null;
  agreed_terms_summary: string | null;
  pending: string;
}

/**
 * Return the body content between `## <heading>` and the next
 * `## ` header (or EOF). Empty string if the heading is absent.
 */
export function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (l) => new RegExp(`^##\\s+${escapeReg(heading)}\\s*$`).test(l.trim()),
  );
  if (start === -1) return "";

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  const section = end === -1 ? rest : rest.slice(0, end);
  return section.join("\n").trim();
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse `## Open Questions` unchecked-box items.
 * Expected form: `- [ ] @handle (YYYY-MM-DD): question text`
 */
export function parseOpenQuestions(section: string): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  const pattern =
    /^\s*-\s*\[\s*\]\s*@([A-Za-z0-9_-]{1,30})\s*\((\d{4}-\d{2}-\d{2})\)\s*:\s*(.+)$/;
  for (const line of section.split("\n")) {
    const m = line.match(pattern);
    if (!m) continue;
    out.push({
      asker: `@${m[1]}`,
      asked_on: m[2],
      question: m[3].trim(),
    });
  }
  return out;
}

/**
 * Parse `## Active Negotiations` subheads.
 *
 * Expected form:
 * ```
 * ### Channel <uuid> — @handle
 * - Agreed: ...
 * - Pending: ...
 * ```
 * The em-dash separator may be `—`, `-`, or `--`. `<uuid>` may be
 * literal (`<uuid>`) in templates or a real id.
 */
export function parseActiveNegotiations(
  section: string,
): ActiveNegotiation[] {
  const out: ActiveNegotiation[] = [];
  const entries = splitOnSubheadings(section);
  for (const entry of entries) {
    const header = parseNegotiationHeader(entry.heading);
    if (!header) continue;
    const agreed = extractBullet(entry.body, "Agreed");
    const pending = extractBullet(entry.body, "Pending") ?? "";
    const listing = extractBullet(entry.body, "Listing");
    out.push({
      channel_id: header.channel_id,
      counterparty: header.counterparty,
      listing_id: extractUuid(listing),
      agreed_price_cents: agreed ? extractPriceCents(agreed) : null,
      agreed_terms_summary: agreed,
      pending,
    });
  }
  return out;
}

interface SubheadBlock { heading: string; body: string }

function splitOnSubheadings(section: string): SubheadBlock[] {
  const blocks: SubheadBlock[] = [];
  const lines = section.split("\n");
  let current: SubheadBlock | null = null;
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current) blocks.push(current);
      current = { heading: line.replace(/^###\s+/, "").trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseNegotiationHeader(
  heading: string,
): { channel_id: string; counterparty: string } | null {
  const m = heading.match(
    /^Channel\s+<?([A-Za-z0-9_-]+)>?\s*[—\-]+\s*@?([A-Za-z0-9_-]{1,30})/,
  );
  if (!m) return null;
  return {
    channel_id: m[1],
    counterparty: `@${m[2]}`,
  };
}

function extractBullet(body: string, label: string): string | null {
  const pattern = new RegExp(
    `^\\s*-\\s*${escapeReg(label)}\\s*:\\s*(.+)$`,
    "mi",
  );
  const m = body.match(pattern);
  return m ? m[1].trim() : null;
}

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Pull a UUID out of a bullet value like `"abc-..."` or `"<uuid>"`
 * (template literal). Returns null when no valid UUID is present so
 * unfilled templates don't pollute the pending digest.
 */
function extractUuid(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(UUID_RE);
  return m ? m[1] : null;
}

/**
 * Extract a dollar amount from free text and convert to cents.
 * Matches `$120`, `$120.50`, `$1,200`. Returns null if none found.
 */
export function extractPriceCents(text: string): number | null {
  const m = text.match(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const dollars = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}
