import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

const { default: plugin } = await import("../src/index.js");
type PluginApiParam = Parameters<typeof plugin.register>[0];

function api() {
  return {
    pluginConfig: {
      platform: { baseUrl: "https://api.velanir.test" },
      batch: { flushIntervalMs: 0 },
    },
    logger: { warn: vi.fn(), debug: vi.fn() },
    registerService: vi.fn(),
    on: vi.fn(),
  };
}

describe("plugin entry", () => {
  it("registers lifecycle service and supported OpenClaw usage hooks", () => {
    const testApi = api();

    plugin.register(testApi as unknown as PluginApiParam);

    expect(testApi.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "llm-usage-reporter" }),
    );
    expect(testApi.on).toHaveBeenCalledWith("model_call_ended", expect.any(Function));
    expect(testApi.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
  });
});
