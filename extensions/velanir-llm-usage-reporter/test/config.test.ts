import { describe, expect, it } from "vitest";
import { buildIngestUrl, CONFIG_DEFAULTS, normalizeConfig } from "../src/config.js";

describe("llm usage reporter config", () => {
  it("defaults to runtime OCT8_API_URL and the runtime observability endpoint", () => {
    const config = normalizeConfig({}, { OCT8_API_URL: "https://api.velanir.test" });

    expect(config.enabled).toBe(true);
    expect(config.platform.baseUrl).toBe("https://api.velanir.test");
    expect(config.platform.endpointPath).toBe(CONFIG_DEFAULTS.endpointPath);
    expect(buildIngestUrl(config)).toBe(
      "https://api.velanir.test/v1/runtime/observability/llm-usage",
    );
  });

  it("bounds batch settings and keeps content disabled by default", () => {
    const config = normalizeConfig({
      batch: {
        maxBatchSize: 9999,
        maxQueueSize: 0,
        flushIntervalMs: -1,
        requestTimeoutMs: 100,
      },
      metadata: {
        includeRawUsage: false,
        includeContent: true,
      },
    });

    expect(config.batch.maxBatchSize).toBe(CONFIG_DEFAULTS.maxBatchSize);
    expect(config.batch.maxQueueSize).toBe(CONFIG_DEFAULTS.maxQueueSize);
    expect(config.batch.flushIntervalMs).toBe(CONFIG_DEFAULTS.flushIntervalMs);
    expect(config.batch.requestTimeoutMs).toBe(CONFIG_DEFAULTS.requestTimeoutMs);
    expect(config.metadata.includeRawUsage).toBe(false);
    expect(config.metadata.includeContent).toBe(true);
  });

  it("fails loudly when the platform base URL is unavailable", () => {
    const config = normalizeConfig({}, {});

    expect(() => buildIngestUrl(config)).toThrow("platform baseUrl");
  });
});
