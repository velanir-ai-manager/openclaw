import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, normalizeConfig } from "../src/config.js";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  configSchema: {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };
  uiHints: Record<string, unknown>;
};

describe("normalizeConfig", () => {
  it("uses conservative defaults", () => {
    const config = normalizeConfig({}, {});

    expect(config.mode).toBe("shadow");
    expect(config.context.source).toBe("platform");
    expect(config.context.maxMessages).toBe(CONFIG_DEFAULTS.maxMessages);
    expect(config.context.refreshMs).toBe(CONFIG_DEFAULTS.refreshMs);
    expect(config.classifier.timeoutMs).toBe(CONFIG_DEFAULTS.timeoutMs);
    expect(config.classifier.maxOutputTokens).toBe(CONFIG_DEFAULTS.maxOutputTokens);
    expect(config.classifier.threshold).toBe(CONFIG_DEFAULTS.classifierThreshold);
    expect(config.logging.classifierDebug).toBe(false);
    expect(config.platform.authMode).toBe("runtime");
    expect(config.platform.endpointPath).toBe(CONFIG_DEFAULTS.platformEndpointPath);
  });

  it("reads platform base values from explicit env vars only", () => {
    const config = normalizeConfig(
      {},
      {
        OCT8_API_URL: "https://api.velanir.test",
        OCT8_COWORKER_ID: "coworker_albus",
        OCT8_PARTICIPATION_CONTEXT_TOKEN: "scoped-token",
        OCT8_API_SECRET: "broad-secret",
      },
    );

    expect(config.platform.baseUrl).toBe("https://api.velanir.test");
    expect(config.platform.coworkerId).toBe("coworker_albus");
    expect(config.platform.authMode).toBe("runtime");
    expect(config.platform.token).toBeUndefined();
  });

  it("uses static platform tokens only when explicitly configured for local prototype mode", () => {
    const config = normalizeConfig(
      {
        platform: {
          authMode: "static-token",
        },
      },
      {
        OCT8_API_URL: "https://api.velanir.test",
        OCT8_COWORKER_ID: "coworker_albus",
        OCT8_PARTICIPATION_CONTEXT_TOKEN: "scoped-token",
      },
    );

    expect(config.platform.authMode).toBe("static-token");
    expect(config.platform.token).toBe("scoped-token");
  });

  it("does not fall back to OCT8_API_SECRET", () => {
    const config = normalizeConfig(
      {},
      {
        OCT8_API_SECRET: "broad-secret",
      },
    );

    expect(config.platform.token).toBeUndefined();
  });

  it("normalizes classifier threshold and debug logging", () => {
    const config = normalizeConfig(
      {
        classifier: { threshold: 0.82 },
        logging: { classifierDebug: true, includeContent: true },
      },
      {},
    );

    expect(config.classifier.threshold).toBe(0.82);
    expect(config.logging.classifierDebug).toBe(true);
    expect(config.logging.includeContent).toBe(true);
  });

  it("rejects invalid classifier threshold values", () => {
    const config = normalizeConfig({ classifier: { threshold: 2 } }, {});

    expect(config.classifier.threshold).toBe(CONFIG_DEFAULTS.classifierThreshold);
  });

  it("defaults delivery to rollback-safe passthrough", () => {
    const config = normalizeConfig({}, {});

    expect(config.delivery).toEqual({
      mode: "passthrough",
      quietWindowMs: CONFIG_DEFAULTS.deliveryQuietWindowMs,
      maxProgressMessages: CONFIG_DEFAULTS.deliveryMaxProgressMessages,
      progressText: CONFIG_DEFAULTS.deliveryProgressText,
      turnTtlMs: CONFIG_DEFAULTS.deliveryTurnTtlMs,
    });
  });

  it("requires an explicit coalesce opt-in and rejects unknown delivery modes", () => {
    expect(normalizeConfig({ delivery: { mode: "coalesce" } }, {}).delivery.mode).toBe("coalesce");
    expect(normalizeConfig({ delivery: { mode: "COALESCE" } }, {}).delivery.mode).toBe(
      "passthrough",
    );
    expect(normalizeConfig({ delivery: {} }, {}).delivery.mode).toBe("passthrough");
  });

  it("normalizes delivery tuning values", () => {
    const config = normalizeConfig(
      {
        delivery: {
          mode: "coalesce",
          quietWindowMs: 30_000,
          maxProgressMessages: 0,
          progressText: "One moment.",
          turnTtlMs: 120_000,
        },
      },
      {},
    );

    expect(config.delivery).toEqual({
      mode: "coalesce",
      quietWindowMs: 30_000,
      maxProgressMessages: 0,
      progressText: "One moment.",
      turnTtlMs: 120_000,
    });
  });

  it("caps maxProgressMessages at 1 and rejects invalid delivery values", () => {
    const config = normalizeConfig(
      {
        delivery: {
          mode: "coalesce",
          maxProgressMessages: 5,
          quietWindowMs: -1,
          progressText: "   ",
          turnTtlMs: 0,
        },
      },
      {},
    );

    expect(config.delivery.maxProgressMessages).toBe(1);
    expect(config.delivery.quietWindowMs).toBe(CONFIG_DEFAULTS.deliveryQuietWindowMs);
    expect(config.delivery.progressText).toBe(CONFIG_DEFAULTS.deliveryProgressText);
    expect(config.delivery.turnTtlMs).toBe(CONFIG_DEFAULTS.deliveryTurnTtlMs);
  });

  it("keeps delivery config keys in the plugin manifest schema", () => {
    expect(manifest.configSchema.properties.delivery.properties).toMatchObject({
      mode: { type: "string", enum: ["passthrough", "coalesce"], default: "passthrough" },
      quietWindowMs: { type: "number", minimum: 0, default: 45000 },
      maxProgressMessages: { type: "number", minimum: 0, maximum: 1, default: 1 },
      turnTtlMs: { type: "number", minimum: 1, default: 600000 },
    });
    expect(manifest.uiHints).toHaveProperty("delivery.mode");
    expect(manifest.uiHints).toHaveProperty("delivery.maxProgressMessages");
  });

  it("keeps deployable config keys in the plugin manifest schema", () => {
    expect(manifest.configSchema.properties.classifier.properties).toMatchObject({
      threshold: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
    });
    expect(manifest.configSchema.properties.logging.properties).toMatchObject({
      classifierDebug: { type: "boolean", default: false },
    });
    expect(manifest.uiHints).toHaveProperty("classifier.threshold");
    expect(manifest.uiHints).toHaveProperty("logging.classifierDebug");
  });

  it("normalizes static context and removes self from coworkers", () => {
    const config = normalizeConfig(
      {
        context: { source: "static" },
        staticContext: {
          self: { id: "albus", names: ["Albus", "Albus"] },
          coworkers: [
            { id: "albus", names: ["Albus"] },
            { id: "tanya", names: ["Tanya", "Tanya Dean"], roleSummary: "Executive assistant" },
          ],
        },
      },
      {},
    );

    expect(config.staticContext).toEqual({
      self: { id: "albus", names: ["Albus"] },
      coworkers: [
        { id: "tanya", names: ["Tanya", "Tanya Dean"], roleSummary: "Executive assistant" },
      ],
    });
  });
});
