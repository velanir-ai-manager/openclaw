import type {
  ClassifierConfig,
  DeliveryConfig,
  DeliveryMode,
  ParticipationContext,
  ParticipationContextSource,
  ParticipationGateConfig,
  ParticipationMode,
  PlatformContextAuthMode,
  PlatformContextConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32;
const DEFAULT_CLASSIFIER_THRESHOLD = 0.7;
const DEFAULT_MAX_MESSAGES = 5;
const DEFAULT_REFRESH_MS = 5 * 60 * 1_000;
const DEFAULT_PLATFORM_ENDPOINT_PATH = "/v1/runtime/coworkers/{coworkerId}/participation-context";
const DEFAULT_DELIVERY_QUIET_WINDOW_MS = 45_000;
const DEFAULT_DELIVERY_MAX_PROGRESS_MESSAGES = 1;
const DEFAULT_DELIVERY_PROGRESS_TEXT =
  "Still working on this — I’ll send the result when it’s complete.";
const DEFAULT_DELIVERY_TURN_TTL_MS = 10 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function readRatio(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function normalizeMode(value: unknown): ParticipationMode {
  return value === "enforce" ? "enforce" : "shadow";
}

function normalizeContextSource(value: unknown): ParticipationContextSource {
  return value === "static" ? "static" : "platform";
}

function normalizePlatformAuthMode(value: unknown): PlatformContextAuthMode {
  return value === "static-token" ? "static-token" : "runtime";
}

function normalizeDeliveryMode(value: unknown): DeliveryMode {
  // Rollback safety: anything other than an explicit "coalesce" opt-in keeps
  // OpenClaw's normal delivery path untouched.
  return value === "coalesce" ? "coalesce" : "passthrough";
}

function normalizeDelivery(value: unknown): DeliveryConfig {
  const record = isRecord(value) ? value : {};
  return {
    mode: normalizeDeliveryMode(record.mode),
    quietWindowMs: readPositiveInteger(record.quietWindowMs, DEFAULT_DELIVERY_QUIET_WINDOW_MS),
    maxProgressMessages: Math.min(
      1,
      readPositiveInteger(record.maxProgressMessages, DEFAULT_DELIVERY_MAX_PROGRESS_MESSAGES),
    ),
    progressText: readString(record.progressText) ?? DEFAULT_DELIVERY_PROGRESS_TEXT,
    turnTtlMs:
      readPositiveInteger(record.turnTtlMs, DEFAULT_DELIVERY_TURN_TTL_MS) ||
      DEFAULT_DELIVERY_TURN_TTL_MS,
  };
}

function normalizeClassifier(value: unknown): ClassifierConfig {
  const record = isRecord(value) ? value : {};
  return {
    provider: readString(record.provider),
    model: readString(record.model),
    authProfileId: readString(record.authProfileId),
    timeoutMs: readPositiveInteger(record.timeoutMs, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxOutputTokens:
      readPositiveInteger(record.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS) ||
      DEFAULT_MAX_OUTPUT_TOKENS,
    threshold: readRatio(record.threshold, DEFAULT_CLASSIFIER_THRESHOLD),
  };
}

function normalizePlatform(value: unknown, env: NodeJS.ProcessEnv): PlatformContextConfig {
  const record = isRecord(value) ? value : {};
  const authMode = normalizePlatformAuthMode(record.authMode);
  return {
    authMode,
    baseUrl: readString(record.baseUrl) ?? readString(env.OCT8_API_URL),
    coworkerId: readString(record.coworkerId) ?? readString(env.OCT8_COWORKER_ID),
    token:
      authMode === "static-token"
        ? (readString(record.token) ?? readString(env.OCT8_PARTICIPATION_CONTEXT_TOKEN))
        : undefined,
    endpointPath: readString(record.endpointPath) ?? DEFAULT_PLATFORM_ENDPOINT_PATH,
  };
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value.map(readString).filter((entry): entry is string => Boolean(entry));
  return [...new Set(names)];
}

function normalizeIdentity(value: unknown): ParticipationContext["self"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  const names = normalizeNames(value.names);
  if (!id || names.length === 0) {
    return undefined;
  }
  const roleSummary = readString(value.roleSummary);
  return {
    id,
    names,
    ...(roleSummary ? { roleSummary } : {}),
  };
}

function normalizeStaticContext(value: unknown): ParticipationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const self = normalizeIdentity(value.self);
  if (!self) {
    return undefined;
  }
  const coworkers = Array.isArray(value.coworkers)
    ? value.coworkers
        .map(normalizeIdentity)
        .filter((entry): entry is ParticipationContext["self"] => Boolean(entry))
    : [];
  return {
    self,
    coworkers: coworkers.filter((entry) => entry.id !== self.id),
  };
}

export function normalizeConfig(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ParticipationGateConfig {
  const record = isRecord(pluginConfig) ? pluginConfig : {};
  const contextRecord = isRecord(record.context) ? record.context : {};
  const loggingRecord = isRecord(record.logging) ? record.logging : {};

  return {
    mode: normalizeMode(record.mode),
    classifier: normalizeClassifier(record.classifier),
    context: {
      source: normalizeContextSource(contextRecord.source),
      maxMessages: readPositiveInteger(contextRecord.maxMessages, DEFAULT_MAX_MESSAGES),
      refreshMs:
        readPositiveInteger(contextRecord.refreshMs, DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS,
    },
    platform: normalizePlatform(record.platform, env),
    staticContext: normalizeStaticContext(record.staticContext),
    delivery: normalizeDelivery(record.delivery),
    logging: {
      decisions: loggingRecord.decisions !== false,
      includeContent: loggingRecord.includeContent === true,
      classifierDebug: loggingRecord.classifierDebug === true,
    },
  };
}

export const CONFIG_DEFAULTS = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  classifierThreshold: DEFAULT_CLASSIFIER_THRESHOLD,
  maxMessages: DEFAULT_MAX_MESSAGES,
  refreshMs: DEFAULT_REFRESH_MS,
  platformEndpointPath: DEFAULT_PLATFORM_ENDPOINT_PATH,
  deliveryQuietWindowMs: DEFAULT_DELIVERY_QUIET_WINDOW_MS,
  deliveryMaxProgressMessages: DEFAULT_DELIVERY_MAX_PROGRESS_MESSAGES,
  deliveryProgressText: DEFAULT_DELIVERY_PROGRESS_TEXT,
  deliveryTurnTtlMs: DEFAULT_DELIVERY_TURN_TTL_MS,
} as const;
