// Pending-responsibility-context OpenClaw plugin.
//
// Canonical 0.4.0 behavior:
// - pending state remains exact-session/exact-user scoped;
// - a fresh, host-observed inbound message is the only authorization for an
//   action tool; model params never carry a message id;
// - only a turn with matching pending context is made quiet;
// - one action is admitted per run, then every follow-up tool is blocked;
// - final delivery and persisted assistant text are derived from the typed
//   runner receipt rather than an ungrounded scheduling-success claim.

import {
  definePluginEntry,
  type AgentToolFactory,
  type AgentToolLike,
  type AgentTurnPrepareContext,
  type AgentTurnPrepareEvent,
  type AgentTurnPrepareResult,
  type OpenClawPluginApi,
  type ToolFactoryContext,
} from "./api.js";
import {
  assistantMessageText,
  isRecord,
  replaceReplyPayloadText,
  replyPayloadText,
  type ReplyPayloadEvent,
  withAssistantMessageText,
} from "./assistant-message.js";
import {
  ACTION_TOOLS,
  createInboundAuthorizationStore,
  sharedInboundAuthorizationState,
  type InboundAuthorizationStore,
} from "./authorization.js";
import { normalizeConfig } from "./config.js";
import {
  claimsSchedulingSuccess,
  createTransactionDeliveryStore,
  hasCompleteSchedulingReceipts,
  sharedTransactionDeliveryState,
  type TransactionDeliveryStore,
} from "./delivery.js";
import { buildInjectionBlock } from "./injection.js";
import {
  makeReadToolFactory,
  scopedItems,
  toolResult,
  toolScopeFromContext,
  turnScopeFromContext,
  type Cache,
} from "./read-tools.js";
import { createRunnerExec } from "./runner-exec.js";
import {
  executeAuthoritativeAction,
  type AuthoritativeActionRequest,
  type RunnerExec,
} from "./source.js";
import {
  CHANGE_CONTRACT,
  PENDING_CONTRACT,
  REJECT_CONTRACT,
  SELECT_OPTION_CONTRACT,
  STATUS_CONTRACT,
  buildIndex,
  runChangeTool,
  runPendingTool,
  runRejectTool,
  runSelectOptionTool,
  runStatusTool,
  type ToolContract,
} from "./tools.js";
import type { DryRunOutcome, PendingInteraction, PluginConfig, ToolError } from "./types.js";

export { toolScopeFromContext, turnScopeFromContext } from "./read-tools.js";

export const PLUGIN_ID = "velanir-pending-context";
export const TRUSTED_ACTION_POLICY_ID = "authoritative-pending-action";

type InboundMessageEvent = {
  messageId?: string;
  senderId?: string;
  from?: string;
  sessionKey?: string;
  runId?: string;
  channel?: string;
};

type MessageContext = {
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

type ToolHookEvent = {
  toolName?: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type ToolHookContext = {
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
  channelId?: string;
};

type PersistedMessageEvent = {
  message?: unknown;
  sessionKey?: string;
};

type PersistedMessageContext = {
  sessionKey?: string;
};

export type PendingContextRuntime = {
  authorization?: InboundAuthorizationStore;
  delivery?: TransactionDeliveryStore;
};

function authorizationError(error: string | undefined): ToolError {
  return {
    ok: false,
    error: "authorization_unavailable",
    message:
      error === "message_replayed"
        ? "This inbound message has already authorized an action. No retry was started."
        : "This action was not securely bound to the current inbound message. No transaction was started.",
  };
}

function actionRequestFromOutcome(
  outcome: DryRunOutcome,
  params: Record<string, unknown>,
  authorization: { messageId: string; senderId: string; sessionKey: string },
): AuthoritativeActionRequest {
  const request: AuthoritativeActionRequest = {
    action: outcome.action as AuthoritativeActionRequest["action"],
    interactionId: outcome.interactionId,
    stateVersion: outcome.stateVersion,
    userMessageId: authorization.messageId,
    authorization: {
      senderId: authorization.senderId,
      sessionKey: authorization.sessionKey,
      messageId: authorization.messageId,
    },
  };
  if (outcome.action === "select_option") request.optionId = outcome.accepted.optionId;
  if (outcome.action === "reject")
    request.reason = typeof params.reason === "string" ? params.reason : undefined;
  if (outcome.action === "change") {
    request.requestedWindow =
      typeof params.requestedWindow === "string" ? params.requestedWindow : undefined;
  }
  return request;
}

function makeActionToolFactory(
  contract: ToolContract,
  config: PluginConfig,
  exec: RunnerExec,
  cache: { value: Cache | null },
  authorizationStore: InboundAuthorizationStore,
  deliveryStore: TransactionDeliveryStore,
  run: (
    items: PendingInteraction[],
    params: Record<string, unknown>,
    dryRun: boolean,
  ) => DryRunOutcome | ToolError,
): AgentToolFactory {
  return (ctx: ToolFactoryContext): AgentToolLike => {
    const scope = toolScopeFromContext(ctx);
    return {
      name: contract.name,
      label: contract.label,
      description: contract.description,
      parameters: contract.parameters,
      execute: async (toolCallId, params) => {
        const hookContext: ToolHookContext = {
          toolName: contract.name,
          toolCallId,
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        };
        const consumed = authorizationStore.consumeDetailed(toolCallId, scope);
        if (!consumed.authorization) {
          const error = authorizationError(consumed.error);
          deliveryStore.finishAction(
            { toolName: contract.name, toolCallId, result: error },
            hookContext,
          );
          return toolResult(error);
        }

        const internalParams = {
          ...((params ?? {}) as Record<string, unknown>),
          userMessageId: consumed.authorization.messageId,
        };
        const items = scopedItems(config, exec, cache, scope);
        const outcome = run(items, internalParams, config.dryRun);
        if (!outcome.ok) {
          deliveryStore.finishAction(
            { toolName: contract.name, toolCallId, result: outcome },
            hookContext,
          );
          return toolResult(outcome);
        }

        if (config.dryRun) {
          deliveryStore.finishAction(
            { toolName: contract.name, toolCallId, result: outcome },
            hookContext,
          );
          const finalText = deliveryStore.expectedFinalTextForToolCall(toolCallId);
          return toolResult({ ...outcome, userVisibleText: finalText });
        }

        const interaction = items.find(
          (candidate) => candidate.interactionId === outcome.interactionId,
        );
        const source = interaction
          ? config.sources.find((candidate) => candidate.id === interaction.source)
          : undefined;
        if (!source) {
          const error: ToolError = {
            ok: false,
            error: "source_unavailable",
            message:
              "The authoritative responsibility source is no longer available. No transaction was started.",
          };
          deliveryStore.finishAction(
            { toolName: contract.name, toolCallId, result: error },
            hookContext,
          );
          return toolResult(error);
        }

        const execution = executeAuthoritativeAction(
          source,
          actionRequestFromOutcome(outcome, internalParams, consumed.authorization),
          exec,
        );
        const result = execution.ok ? execution.outcome : execution.error;
        deliveryStore.finishAction(
          {
            toolName: contract.name,
            toolCallId,
            result,
            ...(execution.ok ? {} : { error: execution.error.error }),
          },
          hookContext,
        );

        if (execution.ok && hasCompleteSchedulingReceipts(execution.outcome)) {
          return toolResult({
            ok: true,
            dryRun: false,
            action: outcome.action,
            interactionId: outcome.interactionId,
            stateVersion: outcome.stateVersion,
            userVisibleText: deliveryStore.expectedFinalTextForToolCall(toolCallId),
          });
        }
        return toolResult(
          execution.ok
            ? {
                ok: false,
                error: "transaction_receipt_invalid",
                message:
                  "The runner did not return the complete receipt required to claim scheduling success.",
              }
            : execution.error,
        );
      },
    };
  };
}

export function registerPendingContextPlugin(
  api: OpenClawPluginApi,
  exec: RunnerExec,
  runtime: PendingContextRuntime = {},
): void {
  const config = normalizeConfig(api.pluginConfig);
  const cache: { value: Cache | null } = { value: null };
  const authorizationStore =
    runtime.authorization ??
    createInboundAuthorizationStore(
      config.authorizationTtlMs,
      Date.now,
      sharedInboundAuthorizationState(),
    );
  const deliveryStore =
    runtime.delivery ??
    createTransactionDeliveryStore(
      config.authorizationTtlMs,
      Date.now,
      sharedTransactionDeliveryState(),
    );

  api.registerTool(
    makeReadToolFactory(PENDING_CONTRACT, config, exec, cache, (items) =>
      runPendingTool(buildIndex(items)),
    ),
  );
  api.registerTool(
    makeActionToolFactory(
      SELECT_OPTION_CONTRACT,
      config,
      exec,
      cache,
      authorizationStore,
      deliveryStore,
      (items, params, dryRun) => runSelectOptionTool(buildIndex(items), params, dryRun),
    ),
  );
  api.registerTool(
    makeActionToolFactory(
      REJECT_CONTRACT,
      config,
      exec,
      cache,
      authorizationStore,
      deliveryStore,
      (items, params, dryRun) => runRejectTool(buildIndex(items), params, dryRun),
    ),
  );
  api.registerTool(
    makeActionToolFactory(
      CHANGE_CONTRACT,
      config,
      exec,
      cache,
      authorizationStore,
      deliveryStore,
      (items, params, dryRun) => runChangeTool(buildIndex(items), params, dryRun),
    ),
  );
  api.registerTool(
    makeReadToolFactory(STATUS_CONTRACT, config, exec, cache, (items, params) =>
      runStatusTool(buildIndex(items), params),
    ),
  );

  // This policy is host-trusted and manifest-declared. It binds the tool call
  // to the inbound message before the model-owned factory executes and makes a
  // second tool/retry loop terminal after one action finishes.
  api.registerTrustedToolPolicy({
    id: TRUSTED_ACTION_POLICY_ID,
    description:
      "Binds pending responsibility actions to one trusted inbound message and blocks post-action retries.",
    evaluate: (event, ctx) => {
      const toolEvent = event as ToolHookEvent;
      const toolContext = ctx as ToolHookContext;
      if (deliveryStore.blockFurtherTool(toolEvent, toolContext)) {
        return { block: true, blockReason: "pending_context_action_already_finished" };
      }
      const toolName = toolEvent.toolName ?? toolContext.toolName;
      if (!toolName || !ACTION_TOOLS.has(toolName)) return undefined;
      const action = deliveryStore.beginAction(toolEvent, toolContext);
      if (!action.tracked) {
        return { block: true, blockReason: "pending_context_missing_run_identity" };
      }
      if (action.duplicate) {
        return { block: true, blockReason: "pending_context_duplicate_action" };
      }
      if (!authorizationStore.bindTool(toolEvent, toolContext)) {
        deliveryStore.failAction(toolEvent, toolContext, "authorization_unavailable");
        return { block: true, blockReason: "pending_context_authorization_unavailable" };
      }
      return undefined;
    },
  });

  api.on("message_received", (event: unknown, ctx: unknown) => {
    authorizationStore.recordInbound(event as InboundMessageEvent, ctx as MessageContext);
    return undefined;
  });

  api.on(
    "agent_turn_prepare",
    (event: unknown, ctx: unknown): AgentTurnPrepareResult | undefined => {
      void (event as AgentTurnPrepareEvent);
      if (config.sources.length === 0) return undefined;
      const turnContext = (ctx ?? {}) as AgentTurnPrepareContext;
      const scope = turnScopeFromContext(turnContext);
      const items = scopedItems(config, exec, cache, scope);
      if (items.length === 0) return undefined;

      // No exact, fresh inbound identity means no quiet-session state. This is
      // why an ordinary chat or a stale transcript cannot become globally final
      // only just because a responsibility happens to have pending state.
      if (authorizationStore.hasFreshBinding(scope, turnContext.runId)) {
        deliveryStore.markPendingTurn(turnContext.runId, scope.sessionKey);
      }
      const block = buildInjectionBlock(items, {
        maxChars: config.maxInjectionChars,
        maxItems: config.maxItemsInInjection,
      });
      if (!block) return undefined;
      if (config.logging.decisions) {
        api.logger?.info?.(
          `[${PLUGIN_ID}] injected ${items.length} pending interaction(s) for session=${scope.sessionKey ?? "?"}`,
        );
      }
      return { appendContext: block };
    },
  );

  api.on("reply_payload_sending", (event: unknown, ctx: unknown) => {
    const reply = event as ReplyPayloadEvent;
    const messageContext = ctx as MessageContext;
    const runId = reply.runId ?? messageContext.runId;
    const sessionKey = reply.sessionKey ?? messageContext.sessionKey;
    if (
      config.suppressNonFinalReplies &&
      reply.kind !== "final" &&
      deliveryStore.suppressNonFinal({ ...reply, runId })
    ) {
      return { cancel: true, reason: "pending_context_suppressed_non_final" };
    }
    if (reply.kind !== "final" || !sessionKey) return undefined;
    if (deliveryStore.finalAlreadyDelivered(sessionKey)) {
      return { cancel: true, reason: "pending_context_duplicate_final" };
    }
    const modelText = replyPayloadText(reply);
    const replacement = deliveryStore.authoritativeFinalForSession(
      sessionKey,
      claimsSchedulingSuccess(modelText),
    );
    const delivered = deliveryStore.markFinalDelivered(sessionKey);
    if (replacement) return replaceReplyPayloadText(reply, replacement);
    // Only mark a final as admitted when it belongs to a tracked pending turn.
    if (!delivered) return undefined;
    return undefined;
  });

  api.on("before_message_write", (event: unknown, ctx: unknown) => {
    const write = event as PersistedMessageEvent;
    const messageContext = ctx as PersistedMessageContext;
    const sessionKey = write.sessionKey ?? messageContext.sessionKey;
    if (!sessionKey || !isRecord(write.message)) return undefined;
    const current = assistantMessageText(write.message);
    if (!current) return undefined;
    const replacement = deliveryStore.authoritativeFinalForSession(
      sessionKey,
      claimsSchedulingSuccess(current),
    );
    if (!replacement || replacement === current) return undefined;
    return { message: withAssistantMessageText(write.message, replacement) };
  });
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Velanir Pending Responsibility Context",
  description:
    "Injects scoped pending responsibility context and finalizes scheduling claims from trusted runner receipts.",
  register(api: OpenClawPluginApi) {
    registerPendingContextPlugin(api, createRunnerExec());
  },
});
