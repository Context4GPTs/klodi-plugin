/**
 * Generate dist/schemas.json from the canonical TypeBox catalog.
 *
 * The Python adapters consume this file directly — they don't run the
 * TypeScript build. Output shape:
 *
 *   {
 *     "version": "3",
 *     "tools": {
 *       "klodi_list_create": {
 *         "subject": "p2p.v1.listings.create",
 *         "description": "...",
 *         "params": { JSON Schema },
 *         "result": { JSON Schema }
 *       },
 *       ...
 *     },
 *     "constants": { ... },
 *     "logging": {
 *       "log_levels": ["DEBUG", "INFO", "WARN", "ERROR"],
 *       "redacted_field_names": [...],
 *       "required_fields_by_site": { ... },
 *       "redaction_placeholder": "[redacted]",
 *       "default_log_level": "INFO"
 *     }
 *   }
 *
 * TypeBox schemas already ARE JSON Schema-compatible (additional metadata
 * keys are stripped here). No external converter needed.
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
const OUT_PATH = join(HERE, "..", "..", "dist", "schemas.json");
const SCHEMA_VERSION = "4";

/**
 * TypeBox attaches its own private `[Symbol.for("TypeBox.Kind")]` markers.
 * We strip those by JSON round-tripping — JSON.stringify ignores Symbol
 * keys, so the output is pure JSON Schema.
 */
function toJsonSchema(typeboxSchema: unknown): unknown {
  return JSON.parse(JSON.stringify(typeboxSchema));
}

interface ToolJson {
  subject: string;
  description: string;
  params: unknown;
  result: unknown;
}

interface LocalToolJson {
  name: string;
  description: string;
  params: unknown;
  result: unknown;
  kind: "local" | "publish";
  host_shapes: readonly string[];
}

interface LoggingJson {
  log_levels: readonly string[];
  redacted_field_names: readonly string[];
  required_fields_by_site: Record<string, readonly string[]>;
  redaction_placeholder: string;
  default_log_level: string;
}

interface CatalogJson {
  version: string;
  tools: Record<string, ToolJson>;
  local_tools: Record<string, LocalToolJson>;
  local_tools_by_host_shape: Record<string, readonly string[]>;
  host_shapes: readonly string[];
  constants: Record<string, string | number>;
  logging: LoggingJson;
}

export function buildJsonSchema(): CatalogJson {
  const tools: Record<string, ToolJson> = {};
  for (const [name, entry] of Object.entries(klodiTools)) {
    tools[name] = {
      subject: entry.subject,
      description: entry.description,
      params: toJsonSchema(entry.params),
      result: toJsonSchema(entry.result),
    };
  }
  const localTools: Record<string, LocalToolJson> = {};
  for (const [name, entry] of Object.entries(LOCAL_TOOLS) as [
    string,
    LocalToolEntry,
  ][]) {
    localTools[name] = {
      name: entry.name,
      description: entry.description,
      params: toJsonSchema(entry.params),
      result: toJsonSchema(entry.result),
      kind: entry.kind,
      host_shapes: [...entry.host_shapes],
    };
  }
  const localToolsByHostShape: Record<string, readonly string[]> = {};
  for (const shape of HOST_SHAPES) {
    localToolsByHostShape[shape] = localToolsForHostShape(shape);
  }
  const constants: Record<string, string | number> = {
    ...KLODI_CATALOG_CONSTANTS,
  };
  const requiredFields: Record<string, readonly string[]> = {};
  for (const [siteType, fields] of Object.entries(REQUIRED_FIELDS_BY_SITE)) {
    requiredFields[siteType] = [...fields];
  }
  const logging: LoggingJson = {
    log_levels: [...LOG_LEVELS],
    redacted_field_names: [...REDACTED_FIELD_NAMES],
    required_fields_by_site: requiredFields,
    redaction_placeholder: REDACTION_PLACEHOLDER,
    default_log_level: DEFAULT_LOG_LEVEL,
  };
  return {
    version: SCHEMA_VERSION,
    tools,
    local_tools: localTools,
    local_tools_by_host_shape: localToolsByHostShape,
    host_shapes: [...HOST_SHAPES],
    constants,
    logging,
  };
}

export function writeJsonSchema(): void {
  const catalog = buildJsonSchema();
  writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log(`[tool-catalog] wrote ${OUT_PATH}`);
}

writeJsonSchema();
