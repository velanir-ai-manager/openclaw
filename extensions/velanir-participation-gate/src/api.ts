import { definePluginEntry as defineOpenClawPluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type OpenClawPluginApi = {
  on: (
    hook:
      | "before_dispatch"
      | "before_tool_call"
      | "message_sending"
      | "message_sent"
      | "reply_payload_sending",
    handler: (event: unknown, ctx: unknown) => unknown,
    options?: { priority?: number; timeoutMs?: number },
  ) => void;
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
