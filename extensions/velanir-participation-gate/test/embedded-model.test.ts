import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { runEmbeddedClassifierModel } from "../src/embedded-model.js";
import type { RuntimeApi } from "../src/types.js";

describe("runEmbeddedClassifierModel", () => {
  it("runs the classifier as a model-only embedded agent call", async () => {
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{ "shouldRespond": false }' }],
    }));
    const config = normalizeConfig(
      {
        classifier: {
          provider: "test-provider",
          model: "test-model",
          authProfileId: "auth-profile",
          timeoutMs: 1234,
          maxOutputTokens: 12,
        },
      },
      {},
    );
    const api = {
      config: { agents: {} },
      runtime: {
        agent: {
          runEmbeddedAgent,
          resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
        },
      },
    } as unknown as RuntimeApi;

    await expect(
      runEmbeddedClassifierModel({
        api,
        config,
        prompt: "Decide.",
      }),
    ).resolves.toBe('{ "shouldRespond": false }');

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Decide.",
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "test-provider",
        model: "test-model",
        authProfileId: "auth-profile",
        authProfileIdSource: "user",
        timeoutMs: 1234,
        modelRun: true,
        explicitStreamParamsOnly: true,
        disableTools: true,
        disableMessageTool: true,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        fastMode: true,
        bootstrapContextMode: "lightweight",
        streamParams: {
          maxTokens: 12,
        },
      }),
    );
  });
});
