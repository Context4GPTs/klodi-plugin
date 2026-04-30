/**
 * Seed and inspect the user's policy files (`negotiation_style.md`,
 * `security.md`) under `${klodi_home}/policies/`.
 *
 * Both seed functions are non-destructive: they copy the bundled
 * template only when the destination is absent. The `*Filled` predicate
 * inspects whether the user has replaced template placeholders so the
 * setup-status flow can guide them through the dialog when needed.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  getNegotiationStylePath,
  getNegotiationStyleTemplatePath,
  getPoliciesDir,
  getSecurityPolicyPath,
  getSecurityPolicyTemplatePath,
} from "./paths.js";

/**
 * Copy the negotiation_style template to the user's policies dir
 * if absent. Never overwrites an existing file. Returns true when
 * a copy was performed, false when the user already had the file.
 */
export function seedNegotiationStyleIfAbsent(): boolean {
  const target = getNegotiationStylePath();
  if (existsSync(target)) return false;

  const templatePath = getNegotiationStyleTemplatePath();
  if (!existsSync(templatePath)) {
    throw new Error(
      `Negotiation style template missing at ${templatePath}.`
      + " Plugin packaging is broken — reinstall klodi-plugin.",
    );
  }

  mkdirSync(getPoliciesDir(), { recursive: true });
  const contents = readFileSync(templatePath, "utf-8");
  writeFileSync(target, contents, "utf-8");
  return true;
}

/**
 * Copy the bundled security.md into the user's policies dir if absent.
 * Mirrors seedNegotiationStyleIfAbsent. security.md is static hard
 * rules — never edited by the user — so a straight copy is correct.
 */
export function seedSecurityPolicyIfAbsent(): boolean {
  const target = getSecurityPolicyPath();
  if (existsSync(target)) return false;

  const templatePath = getSecurityPolicyTemplatePath();
  if (!existsSync(templatePath)) {
    throw new Error(
      `Security policy template missing at ${templatePath}.`
      + " Plugin packaging is broken — reinstall klodi-plugin.",
    );
  }

  mkdirSync(getPoliciesDir(), { recursive: true });
  const contents = readFileSync(templatePath, "utf-8");
  writeFileSync(target, contents, "utf-8");
  return true;
}

/**
 * True when the user has replaced every placeholder token in the
 * seeded negotiation_style.md. Detects the original template by
 * scanning for any remaining `<e.g., ...>` angle-bracket placeholder
 * or the `firm | flexible | aggressive` Posture sentinel. A single
 * remaining placeholder marks the whole file as unfilled.
 */
export function isNegotiationStyleFilled(): boolean {
  const path = getNegotiationStylePath();
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf-8");
  if (/<e\.g\.,/i.test(text)) return false;
  if (/^firm \| flexible \| aggressive\s*$/m.test(text)) return false;
  return true;
}
