/**
 * Mock PluginAPI factory for testing tool and service registration.
 * Captures registered tools/services into maps for assertion.
 *
 * Production OpenClaw injects `config` as the FULL OpenClawConfig tree
 * (plain object — top-level keys like `agents`, `plugins`, etc.) and
 * `pluginConfig` as the plugin-scoped config validated against
 * `openclaw.plugin.json#configSchema`. Neither has a `.get()` method.
 */

import { vi } from "vitest";
import type {
  PluginAPI,
  ToolDefinition,
  ServiceDefinition,
} from "openclaw/plugin-sdk";

export interface MockPluginAPI extends PluginAPI {
  _tools: Map<string, ToolDefinition>;
  _services: Map<string, ServiceDefinition>;
}

export interface CreateMockPluginApiOptions {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export function createMockPluginApi(
  options: CreateMockPluginApiOptions = {},
): MockPluginAPI {
  const tools = new Map<string, ToolDefinition>();
  const services = new Map<string, ServiceDefinition>();

  return {
    _tools: tools,
    _services: services,

    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },

    registerService(service: ServiceDefinition): void {
      services.set(service.id, service);
    },

    runtime: {
      system: {
        enqueueSystemEvent: vi.fn().mockResolvedValue(undefined),
        requestHeartbeatNow: vi.fn(),
      },
    },

    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },

    config: options.config ?? {},
    pluginConfig: options.pluginConfig ?? {},
  } as unknown as MockPluginAPI;
}

/** Retrieve a registered tool by name. Throws if not found. */
export function getTool(api: MockPluginAPI, name: string): ToolDefinition {
  const tool = api._tools.get(name);
  if (!tool) {
    const registered = [...api._tools.keys()].join(", ") || "(none)";
    throw new Error(
      `Tool "${name}" not registered. Registered tools: ${registered}`,
    );
  }
  return tool;
}

/** Retrieve a registered service by id. Throws if not found. */
export function getService(
  api: MockPluginAPI,
  id: string,
): ServiceDefinition {
  const service = api._services.get(id);
  if (!service) {
    const registered = [...api._services.keys()].join(", ") || "(none)";
    throw new Error(
      `Service "${id}" not registered. Registered services: ${registered}`,
    );
  }
  return service;
}
