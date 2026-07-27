import type { AgentHookContext, LlmUsageSurface, LlmUsageTriggerType } from "./types.js";

const RESPONSIBILITY_SESSION_KEY_PATTERN = /^responsibility:([^:]+):([^:]+)$/;

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseResponsibilitySessionKey(value: unknown):
  | {
      responsibilitySlug: string;
      scheduleJobId: string;
    }
  | undefined {
  const sessionKey = nonemptyString(value);
  const match = sessionKey?.match(RESPONSIBILITY_SESSION_KEY_PATTERN);
  if (!match) return undefined;
  return {
    responsibilitySlug: match[1],
    scheduleJobId: match[2],
  };
}

export function attributionFromContext(ctx: AgentHookContext): {
  responsibilityId?: string;
  responsibilityVersionId?: string;
  responsibilitySlug?: string;
  cronJobId?: string;
  cronJobName?: string;
} {
  const parsedSessionKey = parseResponsibilitySessionKey(ctx.sessionKey);
  const responsibilitySlug = parsedSessionKey?.responsibilitySlug;
  const scheduleJobId = parsedSessionKey?.scheduleJobId;
  return {
    responsibilitySlug,
    cronJobId: scheduleJobId ?? nonemptyString(ctx.jobId),
    cronJobName:
      responsibilitySlug && scheduleJobId
        ? `oct8:responsibility:${responsibilitySlug}:${scheduleJobId}`
        : undefined,
  };
}

export function surfaceFromContext(ctx: AgentHookContext): LlmUsageSurface {
  const attribution = attributionFromContext(ctx);
  if (
    attribution.responsibilityId ||
    attribution.responsibilityVersionId ||
    attribution.responsibilitySlug
  ) {
    return "responsibility";
  }

  const source = [
    lower(ctx.messageProvider),
    lower(ctx.channel),
    lower(ctx.trigger),
    lower(ctx.channelId),
  ].join(" ");
  if (source.includes("slack")) return "slack";
  if (source.includes("msteams") || source.includes("teams")) return "msteams";
  if (
    source.includes("customer_api") ||
    source.includes("customer-api") ||
    source.includes("api")
  ) {
    return "customer_api";
  }
  if (ctx.jobId || source.includes("cron")) return "cron";
  if (source.includes("responsibility")) return "responsibility";
  if (source.includes("manual")) return "manual";
  if (source.includes("system") || source.includes("heartbeat")) return "system";
  return "unknown";
}

export function triggerTypeFromContext(
  ctx: AgentHookContext,
  surface: LlmUsageSurface,
): LlmUsageTriggerType {
  const trigger = lower(ctx.trigger);
  const attribution = attributionFromContext(ctx);
  if (ctx.jobId || attribution.cronJobId || surface === "cron" || trigger.includes("cron")) {
    return "cron";
  }
  if (
    attribution.responsibilityId ||
    attribution.responsibilityVersionId ||
    attribution.responsibilitySlug ||
    trigger.includes("responsibility") ||
    surface === "responsibility"
  ) {
    return "responsibility";
  }
  if (
    surface === "customer_api" ||
    trigger.includes("customer_api") ||
    trigger.includes("customer-api")
  ) {
    return "customer_api";
  }
  if (trigger.includes("manual") || surface === "manual") return "manual";
  if (trigger.includes("system") || surface === "system") return "system";
  if (surface === "slack" || surface === "msteams") return "user_message";
  return "unknown";
}
