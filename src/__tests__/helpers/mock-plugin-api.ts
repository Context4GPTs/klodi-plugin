/**
 * Mock PluginAPI factory for testing tool and service registration.
 * Captures registered tools/services into maps for assertion.
 *
 * Shape rationale: production OpenClaw injects `config` as the FULL
 * OpenClawConfig tree (plain object — top-level keys like `agents`,
 * `plugins`, etc.) and `pluginConfig` as the plugin-scoped config
 * validated against `openclaw.plugin.json#configSchema`. Neither has
 * a `.get()` method — that was a fictional convenience in older
 * tests that masked a production bug where plugin code walked the
 * wrong tree. See src/lib/api-config.ts for the helper that walks
 * dot-paths against these plain trees.
 */

import { vi } from 'vitest'
import type {
  PluginAPI,
  ToolDefinition,
  ServiceDefinition,
} from 'openclaw/plugin-sdk'

export interface MockPluginAPI extends PluginAPI {
  _tools: Map<string, ToolDefinition>
  _services: Map<string, ServiceDefinition>
}

export interface CreateMockPluginApiOptions {
  /**
   * Plugin-scoped config (what the user sets under
   * `plugins.klodi.config` in OpenClaw). Production wires this into
   * `api.pluginConfig`. Default: empty object.
   */
  pluginConfig?: Record<string, unknown>
  /**
   * Global OpenClaw config tree. Production wires this into
   * `api.config` as a plain object (no `.get()`). Seed the nested
   * path the code under test will walk — e.g.
   * `{ agents: { defaults: { heartbeat: { target: 'last' } } } }`.
   * Default: empty object.
   */
  config?: Record<string, unknown>
}

export function createMockPluginApi(
  options: CreateMockPluginApiOptions = {},
): MockPluginAPI {
  const tools = new Map<string, ToolDefinition>()
  const services = new Map<string, ServiceDefinition>()

  return {
    _tools: tools,
    _services: services,

    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },

    registerService(service: ServiceDefinition): void {
      services.set(service.id, service)
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
  }
}

/** Retrieve a registered tool by name. Throws if not found. */
export function getTool(api: MockPluginAPI, name: string): ToolDefinition {
  const tool = api._tools.get(name)
  if (!tool) {
    const registered = [...api._tools.keys()].join(', ') || '(none)'
    throw new Error(
      `Tool "${name}" not registered. Registered tools: ${registered}`,
    )
  }
  return tool
}

/** Retrieve a registered service by id. Throws if not found. */
export function getService(
  api: MockPluginAPI,
  id: string,
): ServiceDefinition {
  const service = api._services.get(id)
  if (!service) {
    const registered = [...api._services.keys()].join(', ') || '(none)'
    throw new Error(
      `Service "${id}" not registered. Registered services: ${registered}`,
    )
  }
  return service
}
