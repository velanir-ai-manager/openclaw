// Velanir output policy stays plugin-owned while OpenClaw provides generic lifecycle hooks.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  channelIsProtected,
  normalizeEgressGuardConfig,
  type VelanirEgressGuardConfig,
} from "./config.js";
import {
  buildFinalRevisionInstruction,
  evaluateOutboundContent,
  finalAnswerNeedsRevision,
} from "./sanitize.js";

type FinalizeHookResult =
  | {
      action: "revise";
      reason: string;
      retry: {
        instruction: string;
        idempotencyKey: string;
        maxAttempts: number;
      };
    }
  | undefined;

type MessageSendingHookResult =
  | { cancel: true; cancelReason: string; metadata: Record<string, unknown> }
  | { content: string }
  | undefined;

function resolveAgentHookChannel(ctx: {
  channel?: string;
  messageProvider?: string;
  channelId?: string;
}): string | undefined {
  return ctx.channel ?? ctx.messageProvider ?? ctx.channelId;
}

function decisionMetadata(params: {
  decision: "allow" | "rewrite" | "suppress";
  reasons: string[];
  originalLength: number;
  outputLength: number;
}): Record<string, unknown> {
  return {
    egressGuard: {
      decision: params.decision,
      reasons: params.reasons,
      originalLength: params.originalLength,
      outputLength: params.outputLength,
    },
  };
}

function logDecision(
  api: { logger: { info?: (message: string, metadata?: Record<string, unknown>) => void } },
  config: VelanirEgressGuardConfig,
  params: {
    channel: string;
    stage: "finalize" | "delivery";
    decision: string;
    reasons?: string[];
    originalLength: number;
    outputLength: number;
  },
): void {
  api.logger.info?.("velanir-egress-guard decision", {
    channel: params.channel,
    stage: params.stage,
    mode: config.mode,
    decision: params.decision,
    reasons: params.reasons ?? [],
    originalLength: params.originalLength,
    outputLength: params.outputLength,
  });
}

export default definePluginEntry({
  id: "velanir-egress-guard",
  name: "Velanir Egress Guard",
  description: "Context-aware final-answer revision and deterministic outbound sanitization.",
  register(api) {
    // Plugin config is process-stable. OpenClaw requires a Gateway restart after
    // config edits, so the hot outbound path should not re-read the config file.
    const config = normalizeEgressGuardConfig(api.pluginConfig);

    api.on("before_agent_finalize", (event, ctx): FinalizeHookResult => {
      if (config.mode === "off") {
        return undefined;
      }
      const channel = resolveAgentHookChannel(ctx);
      const draft = event.lastAssistantMessage?.trim();
      if (!channel || !draft || !channelIsProtected(config, channel)) {
        return undefined;
      }
      if (!finalAnswerNeedsRevision(draft, config)) {
        return undefined;
      }
      logDecision(api, config, {
        channel,
        stage: "finalize",
        decision: "revise",
        originalLength: draft.length,
        outputLength: draft.length,
      });
      if (config.mode === "shadow") {
        return undefined;
      }
      return {
        action: "revise" as const,
        reason: "Prepare the final answer for user-facing delivery.",
        retry: {
          instruction: buildFinalRevisionInstruction(config),
          idempotencyKey: "velanir-egress-guard.final-output",
          maxAttempts: 1,
        },
      };
    });

    // Run after normal-priority delivery plugins so their rewrites still pass
    // through the deterministic check before channel delivery.
    api.on(
      "message_sending",
      (event, ctx): MessageSendingHookResult => {
        if (config.mode === "off" || !channelIsProtected(config, ctx.channelId)) {
          return undefined;
        }
        const evaluation = evaluateOutboundContent(event.content, config);
        if (evaluation.decision === "allow") {
          return undefined;
        }
        logDecision(api, config, {
          channel: ctx.channelId,
          stage: "delivery",
          decision: evaluation.decision,
          reasons: evaluation.reasons,
          originalLength: evaluation.originalLength,
          outputLength: evaluation.outputLength,
        });
        if (config.mode === "shadow") {
          return undefined;
        }
        if (evaluation.decision === "suppress") {
          return {
            cancel: true,
            cancelReason: "velanir_egress_guard_suppressed",
            metadata: decisionMetadata(evaluation),
          };
        }
        return { content: evaluation.content };
      },
      { priority: -1_000 },
    );
  },
});
