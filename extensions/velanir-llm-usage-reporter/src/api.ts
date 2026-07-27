import { definePluginEntry as defineOpenClawPluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type OpenClawPluginServiceContext = {
  stateDir: string;
  logger: PluginLogger;
};

export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

export type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on: (
    hook: string,
    handler: (event: unknown, ctx: unknown) => unknown,
    opts?: { timeoutMs?: number },
  ) => void;
  registerService: (service: OpenClawPluginService) => void;
};

export type OpenClawPluginEntry = {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
};

export function definePluginEntry<TEntry extends OpenClawPluginEntry>(entry: TEntry): TEntry {
  return defineOpenClawPluginEntry(entry as never) as unknown as TEntry;
}
