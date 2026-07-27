import type { PluginLogger } from "./api.js";

export type LlmUsageSurface =
  | "slack"
  | "msteams"
  | "customer_api"
  | "cron"
  | "responsibility"
  | "manual"
  | "system"
  | "unknown";

export type LlmUsageTriggerType =
  | "user_message"
  | "cron"
  | "responsibility"
  | "manual"
  | "system"
  | "customer_api"
  | "unknown";

export type LlmUsageReporterConfig = {
  enabled: boolean;
  platform: {
    baseUrl?: string;
    endpointPath: string;
  };
  batch: {
    maxBatchSize: number;
    maxQueueSize: number;
    flushIntervalMs: number;
    requestTimeoutMs: number;
  };
  metadata: {
    includeRawUsage: boolean;
    includeContent: boolean;
  };
};

export type OpenClawUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  resolvedRef?: string;
  harnessId?: string;
  prompt?: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: OpenClawUsage;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  contextWindowReferenceTokens?: number;
};

export type ModelCallEndedEvent = {
  runId: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  durationMs: number;
  outcome: "completed" | "error";
  errorCategory?: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  upstreamRequestIdHash?: string;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  contextWindowReferenceTokens?: number;
};

export type AgentHookContext = {
  runId?: string;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  contextWindowReferenceTokens?: number;
};

export type PlatformLlmUsageEvent = {
  sourceEventId: string;
  sourceSystem: "openclaw";
  sourceRunId?: string;
  sourceSessionKey?: string;
  sourceSessionId?: string;
  provider: string;
  model: string;
  endpoint?: string;
  providerRequestId?: string;
  awsRequestId?: string;
  surface: LlmUsageSurface;
  triggerType: LlmUsageTriggerType;
  responsibilityId?: string;
  responsibilityVersionId?: string;
  responsibilitySlug?: string;
  cronJobId?: string;
  cronJobName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  currency: "USD";
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export type RuntimeAuthClient = {
  authorizationHeaders: (requestUrl: string, method: "POST") => Promise<Record<string, string>>;
};

export type LlmUsageReporterDependencies = {
  fetchImpl?: typeof fetch;
  authClient?: RuntimeAuthClient;
  logger?: PluginLogger;
  now?: () => Date;
};
