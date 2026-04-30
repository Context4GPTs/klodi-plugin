/**
 * Generate dist/rust-types.rs from the canonical TypeBox catalog.
 *
 * The Rust adapters consume this file directly. Module D (Rust client)
 * compiles it into the workspace as a generated source. Output shape:
 *
 *   //! Auto-generated from @klodi/tool-catalog. Do not edit.
 *
 *   pub enum ToolName {
 *     KlodiListCreate,
 *     ...
 *   }
 *
 *   impl ToolName {
 *     pub fn subject(&self) -> &'static str { ... }
 *     pub fn name(&self) -> &'static str { ... }
 *   }
 *
 *   pub mod logging {
 *     pub enum LogLevel { Debug, Info, Warn, Error }
 *     pub const REDACTED_FIELD_NAMES: &[&str] = &[...];
 *     pub const REDACTION_PLACEHOLDER: &str = "[redacted]";
 *     pub const DEFAULT_LOG_LEVEL: LogLevel = LogLevel::Info;
 *     pub fn required_fields_by_site(site: &str) -> Option<&'static [&'static str]> { ... }
 *   }
 *
 * Param and result structs are NOT emitted here — their TypeBox schemas
 * carry semantic union/optional shapes that don't 1:1 map to plain serde
 * structs without manual decisions. Module D defines its own typed
 * wrappers and uses serde_json::Value for opaque pass-through; the enum
 * + subject map is the load-bearing contract this codegen owns.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOG_LEVEL,
  HOST_SHAPES,
  KLODI_CATALOG_CONSTANTS,
  LOCAL_TOOLS,
  LOG_LEVELS,
  REDACTED_FIELD_NAMES,
  REDACTION_PLACEHOLDER,
  REQUIRED_FIELDS_BY_SITE,
  klodiTools,
  localToolsForHostShape,
  type LocalToolEntry,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, "..", "..", "dist", "rust-types.rs");

/** Convert klodi_list_create -> KlodiListCreate. */
function toRustVariant(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toRustConstLiteral(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(
        `tool-catalog rust codegen: only integer constants supported (got ${value})`,
      );
    }
    return value.toString();
  }
  return JSON.stringify(value);
}

function toRustConstType(value: string | number): string {
  return typeof value === "number" ? "usize" : "&str";
}

function toRustLogLevelVariant(level: string): string {
  return level.charAt(0) + level.slice(1).toLowerCase();
}

function rustStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export function buildRustTypes(): string {
  const lines: string[] = [];
  lines.push("//! Auto-generated from @klodi/tool-catalog. DO NOT EDIT.");
  lines.push("//!");
  lines.push("//! Source: klodi-plugin/packages/tool-catalog/src/index.ts");
  lines.push("//! Regenerate with: pnpm --filter @klodi/tool-catalog codegen");
  lines.push("");
  lines.push("use serde::{Deserialize, Serialize};");
  lines.push("");

  lines.push("// ─── Cross-language constants (D9, D14) ──────────────────────────────");
  for (const [name, value] of Object.entries(KLODI_CATALOG_CONSTANTS)) {
    lines.push(`/// ${name} — see klodi-plugin/packages/tool-catalog/src/index.ts.`);
    lines.push(
      `pub const ${name}: ${toRustConstType(value)} = ${toRustConstLiteral(value)};`,
    );
  }
  lines.push("");

  lines.push("/// Every klodi_* tool name as a strongly-typed enum.");
  lines.push("#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]");
  lines.push("pub enum ToolName {");

  const entries = Object.entries(klodiTools);
  for (const [name] of entries) {
    lines.push(`    /// ${name}`);
    lines.push(`    ${toRustVariant(name)},`);
  }
  lines.push("}");
  lines.push("");

  lines.push("impl ToolName {");
  lines.push("    /// The public tool name as agents call it (e.g. \"klodi_list_create\").");
  lines.push("    pub fn name(&self) -> &'static str {");
  lines.push("        match self {");
  for (const [name] of entries) {
    lines.push(`            ToolName::${toRustVariant(name)} => "${name}",`);
  }
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push("    /// The NATS subject the marketplace handler listens on.");
  lines.push("    pub fn subject(&self) -> &'static str {");
  lines.push("        match self {");
  for (const [name, entry] of entries) {
    lines.push(`            ToolName::${toRustVariant(name)} => "${entry.subject}",`);
  }
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push("    /// Parse from the public tool name.");
  lines.push("    pub fn from_name(name: &str) -> Option<Self> {");
  lines.push("        match name {");
  for (const [name] of entries) {
    lines.push(`            "${name}" => Some(ToolName::${toRustVariant(name)}),`);
  }
  lines.push("            _ => None,");
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  lines.push("// ─── Logging contract (D15) ───────────────────────────────────────────");
  lines.push("/// Cross-language logging contract: levels, redact list, required-field");
  lines.push("/// map. The `klodi-logger` Rust crate consumes these constants to honor");
  lines.push("/// the contract test in `tests/integration/log-contract.test.ts`.");
  lines.push("pub mod logging {");
  lines.push("    /// Ordered log levels. Lower index = noisier.");
  lines.push("    #[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]");
  lines.push("    pub enum LogLevel {");
  for (const level of LOG_LEVELS) {
    lines.push(`        ${toRustLogLevelVariant(level)},`);
  }
  lines.push("    }");
  lines.push("");
  lines.push("    impl LogLevel {");
  lines.push("        pub fn as_str(&self) -> &'static str {");
  lines.push("            match self {");
  for (const level of LOG_LEVELS) {
    lines.push(
      `                LogLevel::${toRustLogLevelVariant(level)} => "${level}",`,
    );
  }
  lines.push("            }");
  lines.push("        }");
  lines.push("");
  lines.push("        /// Parse from the wire string form. Named `parse_str` (not");
  lines.push("        /// `from_str`) to avoid shadowing `std::str::FromStr::from_str`.");
  lines.push("        pub fn parse_str(s: &str) -> Option<Self> {");
  lines.push("            match s {");
  for (const level of LOG_LEVELS) {
    lines.push(`                "${level}" => Some(LogLevel::${toRustLogLevelVariant(level)}),`);
  }
  lines.push("                _ => None,");
  lines.push("            }");
  lines.push("        }");
  lines.push("");
  lines.push("        pub fn rank(&self) -> u8 {");
  lines.push("            match self {");
  LOG_LEVELS.forEach((level, idx) => {
    lines.push(`                LogLevel::${toRustLogLevelVariant(level)} => ${idx},`);
  });
  lines.push("            }");
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push(`    pub const LOG_LEVELS: &[&str] = &[${LOG_LEVELS.map(rustStringLiteral).join(", ")}];`);
  lines.push("");
  lines.push("    /// Field names whose values are replaced with REDACTION_PLACEHOLDER");
  lines.push("    /// at INFO/WARN/ERROR. DEBUG bypasses redaction.");
  lines.push(
    `    pub const REDACTED_FIELD_NAMES: &[&str] = &[${REDACTED_FIELD_NAMES.map(rustStringLiteral).join(", ")}];`,
  );
  lines.push("");
  lines.push(
    `    pub const REDACTION_PLACEHOLDER: &str = ${rustStringLiteral(REDACTION_PLACEHOLDER)};`,
  );
  lines.push("");
  lines.push(`    pub const DEFAULT_LOG_LEVEL: LogLevel = LogLevel::${toRustLogLevelVariant(DEFAULT_LOG_LEVEL)};`);
  lines.push("");
  lines.push("    /// Required fields per call-site type. Caller-side discipline; the");
  lines.push("    /// integration contract test asserts presence at INFO.");
  lines.push("    pub fn required_fields_by_site(site: &str) -> Option<&'static [&'static str]> {");
  lines.push("        match site {");
  for (const [siteType, fields] of Object.entries(REQUIRED_FIELDS_BY_SITE)) {
    const fieldList = (fields as readonly string[])
      .map(rustStringLiteral)
      .join(", ");
    lines.push(`            "${siteType}" => Some(&[${fieldList}]),`);
  }
  lines.push("            _ => None,");
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push("    /// Every recognised call-site type name.");
  lines.push(
    `    pub const CALL_SITE_TYPES: &[&str] = &[${Object.keys(REQUIRED_FIELDS_BY_SITE)
      .map(rustStringLiteral)
      .join(", ")}];`,
  );
  lines.push("}");
  lines.push("");

  // ─── Local tool registry (D4) ─────────────────────────────────────
  lines.push("// ─── Local-only tools (D4) ────────────────────────────────────────────");
  lines.push("/// Local-only tools that don't map 1:1 to a NATS subject.");
  lines.push("/// Daemon-shape Rust hosts get the empty allowlist for `Daemon`.");
  lines.push("///");
  lines.push("/// `dead_code`: the daemon-shape adapters (Moltis / IronClaw / ZeroClaw)");
  lines.push("/// import this crate but do not register any local tools (their");
  lines.push("/// `for_host_shape(Daemon)` allowlist is empty), so the helper functions");
  lines.push("/// look unused per-crate. They are part of the cross-language contract");
  lines.push("/// surface and are exercised by `tests/integration/cross-language-wire`.");
  lines.push("#[allow(dead_code)]");
  lines.push("pub mod local_tools {");
  lines.push("    /// Adapter shape declared in each adapter's host spec section 2.");
  lines.push("    #[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]");
  lines.push("    pub enum HostShape {");
  for (const shape of HOST_SHAPES) {
    const variant =
      shape.charAt(0).toUpperCase() + shape.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase());
    lines.push(`        ${variant},`);
  }
  lines.push("    }");
  lines.push("");
  lines.push("    impl HostShape {");
  lines.push("        pub fn as_str(&self) -> &'static str {");
  lines.push("            match self {");
  for (const shape of HOST_SHAPES) {
    const variant =
      shape.charAt(0).toUpperCase() + shape.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase());
    lines.push(`                HostShape::${variant} => "${shape}",`);
  }
  lines.push("            }");
  lines.push("        }");
  lines.push("");
  lines.push("        /// Parse from the wire string form. Named `parse_str` (not");
  lines.push("        /// `from_str`) so it doesn't shadow `std::str::FromStr::from_str` —");
  lines.push("        /// clippy's `should_implement_trait` lint enforces this distinction.");
  lines.push("        pub fn parse_str(s: &str) -> Option<Self> {");
  lines.push("            match s {");
  for (const shape of HOST_SHAPES) {
    const variant =
      shape.charAt(0).toUpperCase() + shape.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase());
    lines.push(`                "${shape}" => Some(HostShape::${variant}),`);
  }
  lines.push("                _ => None,");
  lines.push("            }");
  lines.push("        }");
  lines.push("    }");
  lines.push("");
  lines.push(
    `    pub const LOCAL_TOOL_NAMES: &[&str] = &[${Object.keys(LOCAL_TOOLS)
      .map(rustStringLiteral)
      .join(", ")}];`,
  );
  lines.push("");

  // Per-tool host_shapes — emitted as a function so daemon hosts can
  // assert "this name's host_shapes ⊇ [Daemon]" at startup.
  lines.push(
    "    /// Returns the declared host_shapes for a local tool name.",
  );
  lines.push("    pub fn host_shapes_for(name: &str) -> Option<&'static [&'static str]> {");
  lines.push("        match name {");
  for (const [name, entry] of Object.entries(LOCAL_TOOLS) as [
    string,
    LocalToolEntry,
  ][]) {
    const shapeList = entry.host_shapes.map(rustStringLiteral).join(", ");
    lines.push(`            "${name}" => Some(&[${shapeList}]),`);
  }
  lines.push("            _ => None,");
  lines.push("        }");
  lines.push("    }");
  lines.push("");

  // Per-shape allowlist — used by `check-adapter-tools.sh` to assert
  // each adapter registered exactly the catalog's expected set.
  lines.push("    /// Tool names an adapter with `shape` MUST register.");
  lines.push("    pub fn for_host_shape(shape: HostShape) -> &'static [&'static str] {");
  lines.push("        match shape {");
  for (const shape of HOST_SHAPES) {
    const variant =
      shape.charAt(0).toUpperCase() + shape.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase());
    const allowlist = localToolsForHostShape(shape).map(rustStringLiteral).join(", ");
    lines.push(`            HostShape::${variant} => &[${allowlist}],`);
  }
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

export function writeRustTypes(): void {
  const source = buildRustTypes();
  writeFileSync(OUT_PATH, source, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`[tool-catalog] wrote ${OUT_PATH}`);
}

writeRustTypes();
