import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { ParticipationGateConfig, RuntimeApi } from "./types.js";

function collectAssistantText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const payloads = (result as { payloads?: unknown }).payloads;
  if (!Array.isArray(payloads)) {
    return "";
  }
  return payloads
    .map((payload) => {
      if (!payload || typeof payload !== "object") {
        return "";
      }
      const record = payload as { text?: unknown; isError?: unknown };
      return record.isError === true || typeof record.text !== "string" ? "" : record.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function runEmbeddedClassifierModel(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  prompt: string;
}): Promise<string> {
  const agentRuntime = params.api.runtime?.agent;
  const runEmbeddedAgent = agentRuntime?.runEmbeddedAgent ?? agentRuntime?.runEmbeddedPiAgent;
  if (typeof runEmbeddedAgent !== "function") {
    throw new Error("OpenClaw embedded agent runtime is unavailable");
  }

  const provider = params.config.classifier.provider;
  const model = params.config.classifier.model;
  if (!provider || !model) {
    throw new Error("classifier provider/model is not configured");
  }

  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "velanir-participation-gate-"),
    );
    const runId = `participation-gate-${randomUUID()}`;
    const result = await runEmbeddedAgent({
      sessionId: runId,
      sessionFile: path.join(tmpDir, "session.json"),
      workspaceDir: agentRuntime?.resolveAgentWorkspaceDir?.(params.api.config) ?? process.cwd(),
      config: params.api.config,
      prompt: params.prompt,
      timeoutMs: params.config.classifier.timeoutMs,
      runId,
      modelRun: true,
      provider,
      model,
      authProfileId: params.config.classifier.authProfileId,
      authProfileIdSource: params.config.classifier.authProfileId ? "user" : "auto",
      explicitStreamParamsOnly: true,
      streamParams: {
        maxTokens: params.config.classifier.maxOutputTokens,
      },
      disableTools: true,
      disableMessageTool: true,
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      fastMode: true,
      bootstrapContextMode: "lightweight",
    });
    const text = collectAssistantText(result);
    if (!text) {
      throw new Error("classifier returned empty output");
    }
    return text;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
