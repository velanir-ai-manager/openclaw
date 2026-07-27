import type {
  AgentToolFactory,
  AgentToolLike,
  AgentToolResultLike,
  AgentTurnPrepareContext,
  ToolFactoryContext,
} from "./api.js";
import { canonicalizeConversationId, filterForTurn } from "./injection.js";
import { loadPendingFromSources, type RunnerExec } from "./source.js";
import type { ToolContract } from "./tools.js";
import type { PendingInteraction, PluginConfig, TurnScope } from "./types.js";

const CACHE_TTL_MS = 3_000;

export type Cache = { at: number; items: PendingInteraction[] };

function loadItems(
  config: PluginConfig,
  exec: RunnerExec,
  cache: { value: Cache | null },
): PendingInteraction[] {
  const now = Date.now();
  if (cache.value && now - cache.value.at < CACHE_TTL_MS) {
    return cache.value.items;
  }
  const { items } = loadPendingFromSources(config.sources, exec);
  cache.value = { at: now, items };
  return items;
}

export function turnScopeFromContext(ctx: AgentTurnPrepareContext): TurnScope {
  const channel = ctx.channel ?? ctx.messageProvider;
  const conversationId = canonicalizeConversationId(ctx.chatId ?? ctx.channelId, channel);
  return {
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(channel ? { channel } : {}),
    ...(ctx.senderId ? { userId: ctx.senderId } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function toolScopeFromContext(ctx: ToolFactoryContext): TurnScope {
  const channel = ctx.messageChannel ?? ctx.deliveryContext?.channel;
  const accountId = ctx.agentAccountId ?? ctx.deliveryContext?.accountId;
  const conversationId = canonicalizeConversationId(ctx.deliveryContext?.to, channel);
  return {
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(channel ? { channel } : {}),
    ...(ctx.requesterSenderId ? { userId: ctx.requesterSenderId } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function toolResult(payload: unknown): AgentToolResultLike {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

export function scopedItems(
  config: PluginConfig,
  exec: RunnerExec,
  cache: { value: Cache | null },
  scope: TurnScope,
): PendingInteraction[] {
  return filterForTurn(loadItems(config, exec, cache), scope, {
    strictUserScope: config.strictUserScope,
    strictSessionScope: config.strictSessionScope,
  });
}

export function makeReadToolFactory(
  contract: ToolContract,
  config: PluginConfig,
  exec: RunnerExec,
  cache: { value: Cache | null },
  run: (items: PendingInteraction[], params: Record<string, unknown>) => unknown,
): AgentToolFactory {
  return (ctx: ToolFactoryContext): AgentToolLike => {
    const scope = toolScopeFromContext(ctx);
    return {
      name: contract.name,
      label: contract.label,
      description: contract.description,
      parameters: contract.parameters,
      execute: async (_toolCallId, params) =>
        toolResult(
          run(scopedItems(config, exec, cache, scope), (params ?? {}) as Record<string, unknown>),
        ),
    };
  };
}
