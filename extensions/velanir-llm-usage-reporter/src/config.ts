import type { LlmUsageReporterConfig } from "./types.js";

const DEFAULT_ENDPOINT_PATH = "/v1/runtime/observability/llm-usage";
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 2_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readIntegerInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.floor(value);
  return integer >= min && integer <= max ? integer : fallback;
}

export function normalizeConfig(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): LlmUsageReporterConfig {
  const record = isRecord(pluginConfig) ? pluginConfig : {};
  const platformRecord = isRecord(record.platform) ? record.platform : {};
  const batchRecord = isRecord(record.batch) ? record.batch : {};
  const metadataRecord = isRecord(record.metadata) ? record.metadata : {};

  return {
    enabled: record.enabled !== false,
    platform: {
      baseUrl: readString(platformRecord.baseUrl) ?? readString(env.OCT8_API_URL),
      endpointPath: readString(platformRecord.endpointPath) ?? DEFAULT_ENDPOINT_PATH,
    },
    batch: {
      maxBatchSize: readIntegerInRange(batchRecord.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1, 500),
      maxQueueSize: readIntegerInRange(batchRecord.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 1, 10_000),
      flushIntervalMs: readIntegerInRange(
        batchRecord.flushIntervalMs,
        DEFAULT_FLUSH_INTERVAL_MS,
        0,
        600_000,
      ),
      requestTimeoutMs: readIntegerInRange(
        batchRecord.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        1_000,
        60_000,
      ),
    },
    metadata: {
      includeRawUsage: metadataRecord.includeRawUsage !== false,
      includeContent: metadataRecord.includeContent === true,
    },
  };
}

export function buildIngestUrl(config: LlmUsageReporterConfig): string {
  if (!config.platform.baseUrl) {
    throw new Error("platform baseUrl is not configured");
  }
  return new URL(
    config.platform.endpointPath,
    config.platform.baseUrl.endsWith("/") ? config.platform.baseUrl : `${config.platform.baseUrl}/`,
  ).href;
}

export const CONFIG_DEFAULTS = {
  endpointPath: DEFAULT_ENDPOINT_PATH,
  maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
} as const;
