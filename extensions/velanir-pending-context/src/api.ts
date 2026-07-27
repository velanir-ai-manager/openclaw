// Thin typed facade over the OpenClaw plugin SDK, matching participation-gate's
// convention (build/packaging/registration). Verified against
// openclaw@2026.7.1-beta.5+ `plugin-sdk/plugin-entry`:
//   - api.registerTool(tool, opts)                     (registers agent tools)
//   - api.registerSessionExtension(ext)                (host-owned session state)
//   - api.registerTrustedToolPolicy(policy)            (pre-execution tool gate)
//   - api.on with a hook name, handler, and options   (lifecycle hooks:
//       agent_turn_prepare, message_received, before_tool_call, after_tool_call,
//       before_agent_finalize, before_message_write, reply_payload_sending)
//   - api.setRunContext/getRunContext (or api.runContext.*) for run-scoped state
//   - api.pluginConfig, api.logger
// This file is the ONLY place OpenClaw types are imported; all core logic
// modules stay OpenClaw-free so they run under `node --test`.
import { definePluginEntry as defineOpenClawPluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

// Minimal shape of an OpenClaw agent tool (AnyAgentTool). `parameters` is a
// TypeBox TSchema at runtime; we pass a structurally-compatible JSON Schema and
// erase the type at the registration boundary.
export type AgentToolLike = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
  ) => Promise<AgentToolResultLike>;
};

export type AgentToolResultLike = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

// Subset of OpenClawPluginToolContext (openclaw@2026.7.1-beta.5) used to scope
// a tool invocation to the calling agent/channel/user. Registering a tool
// FACTORY (rather than a bare tool) is how a plugin receives this context.
export type ToolFactoryContext = {
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  // Host-authoritative id of the inbound message that started this turn; the
  // trusted binding for responsibility_select_option.
  requesterMessageId?: string;
  deliveryContext?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

export type AgentToolFactory = (
  ctx: ToolFactoryContext,
) => AgentToolLike | AgentToolLike[] | null | undefined;

// Event/context for the "agent_turn_prepare" hook (openclaw@2026.7.1-beta.5:
// PluginAgentTurnPrepareEvent / PluginHookAgentContext / PluginAgentTurnPrepareResult).
export type AgentTurnPrepareEvent = {
  prompt: string;
  messages: unknown[];
  queuedInjections: unknown[];
};

export type AgentTurnPrepareContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  channelId?: string;
  chatId?: string;
  senderId?: string;
  messageProvider?: string;
  workspaceDir?: string;
};

export type AgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export type SessionExtensionRegistration = {
  namespace: string;
  description: string;
  project?: (ctx: {
    sessionKey: string;
    sessionId?: string;
    state: PluginJsonValue | undefined;
  }) => PluginJsonValue | undefined;
};

export type TrustedToolPolicyEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type TrustedToolPolicyContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  channelId?: string;
  getSessionExtension?: (namespace: string) => PluginJsonValue | undefined;
};

export type TrustedToolPolicyDecision = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

export type TrustedToolPolicyRegistration = {
  id: string;
  description: string;
  evaluate: (
    event: TrustedToolPolicyEvent,
    ctx: TrustedToolPolicyContext,
  ) => TrustedToolPolicyDecision | void | Promise<TrustedToolPolicyDecision | void>;
};

export type RunContextPatch = {
  runId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
};

export type RunContextQuery = {
  runId: string;
  namespace: string;
};

export type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: PluginLogger;
  // Run-scoped host state. Older hosts expose top-level setRunContext /
  // getRunContext; newer hosts group them under `runContext`.
  setRunContext?: (patch: RunContextPatch) => boolean;
  getRunContext?: (params: RunContextQuery) => PluginJsonValue | undefined;
  runContext?: {
    setRunContext: (patch: RunContextPatch) => boolean;
    getRunContext: (params: RunContextQuery) => PluginJsonValue | undefined;
  };
  registerTool: (
    tool: AgentToolLike | AgentToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
  registerSessionExtension: (extension: SessionExtensionRegistration) => void;
  registerTrustedToolPolicy: (policy: TrustedToolPolicyRegistration) => void;
  on: (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>,
    opts?: { priority?: number; timeoutMs?: number },
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
