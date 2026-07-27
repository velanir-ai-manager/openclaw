import { describe, expect, it, vi } from "vitest";
import { normalizeEgressGuardConfig } from "./config.js";
import plugin from "./index.js";
import {
  buildFinalRevisionInstruction,
  evaluateOutboundContent,
  finalAnswerNeedsRevision,
} from "./sanitize.js";

type Hook = (event: unknown, ctx: unknown) => unknown;

function registerPlugin(pluginConfig: unknown) {
  const hooks = new Map<string, Hook>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  plugin.register({
    pluginConfig,
    logger,
    on: (name: string, handler: Hook) => {
      hooks.set(name, handler);
    },
  } as never);
  return {
    logger,
    hook(name: string): Hook {
      const hook = hooks.get(name);
      if (!hook) {
        throw new Error(`Missing hook ${name}`);
      }
      return hook;
    },
  };
}

describe("Velanir egress guard config", () => {
  it("defaults to off and keeps the operator-facing surface small", () => {
    expect(normalizeEgressGuardConfig(undefined)).toEqual({
      mode: "off",
      channels: ["slack", "msteams"],
      finalOutput: {
        mode: "when_needed",
        style: "friendly",
        maxEmojis: 1,
        forbidEmDash: true,
      },
    });
  });

  it("normalizes configured channels and final-output settings", () => {
    expect(
      normalizeEgressGuardConfig({
        mode: "enforce",
        channels: ["Slack", "msteams", "slack"],
        finalOutput: { mode: "always", style: "plain", maxEmojis: 0, forbidEmDash: false },
      }),
    ).toEqual({
      mode: "enforce",
      channels: ["slack", "msteams"],
      finalOutput: {
        mode: "always",
        style: "plain",
        maxEmojis: 0,
        forbidEmDash: false,
      },
    });
  });
});

describe("Velanir outbound sanitization", () => {
  const config = normalizeEgressGuardConfig({ mode: "enforce" });

  it("leaves clean business output unchanged", () => {
    expect(evaluateOutboundContent("The renewal is approved for Friday.", config)).toMatchObject({
      decision: "allow",
      content: "The renewal is approved for Friday.",
      reasons: [],
    });
  });

  it("preserves a useful answer while stripping a raw internal payload", () => {
    const result = evaluateOutboundContent(
      [
        "The customer list is ready.",
        "",
        "```json",
        '{"toolCalls":[{"result":{"externalContent":"internal"}}]}',
        "```",
      ].join("\n"),
      config,
    );
    expect(result).toMatchObject({
      decision: "rewrite",
      content: "The customer list is ready.",
      reasons: ["raw_payload"],
    });
  });

  it("suppresses internal-only mechanics instead of inventing fallback copy", () => {
    const result = evaluateOutboundContent(
      "The internal model used the hidden config and session id before returning tool logs.",
      config,
    );
    expect(result).toMatchObject({
      decision: "suppress",
      content: "",
      reasons: ["internal_mechanics"],
      outputLength: 0,
    });
  });

  it("applies restrained presentation cleanup deterministically", () => {
    const result = evaluateOutboundContent("Done — everything is ready ✅ 🎉", config);
    expect(result).toMatchObject({
      decision: "rewrite",
      content: "Done - everything is ready ✅",
      reasons: ["presentation_policy"],
    });
  });
});

describe("Velanir final-output revision", () => {
  it("uses one bounded context-aware pass for always mode", () => {
    const registered = registerPlugin({
      mode: "enforce",
      finalOutput: { mode: "always", style: "friendly", maxEmojis: 1 },
    });
    const result = registered.hook("before_agent_finalize")(
      { lastAssistantMessage: "The work is complete." },
      { channel: "slack" },
    );
    expect(result).toEqual({
      action: "revise",
      reason: "Prepare the final answer for user-facing delivery.",
      retry: {
        instruction: expect.stringContaining("Preserve every verified outcome"),
        idempotencyKey: "velanir-egress-guard.final-output",
        maxAttempts: 1,
      },
    });
  });

  it("does not revise a clean answer in when-needed mode", () => {
    const config = normalizeEgressGuardConfig({ mode: "enforce" });
    expect(finalAnswerNeedsRevision("The renewal is approved.", config)).toBe(false);
  });

  it("keeps shadow mode observational", () => {
    const registered = registerPlugin({
      mode: "shadow",
      finalOutput: { mode: "always" },
    });
    expect(
      registered.hook("before_agent_finalize")(
        { lastAssistantMessage: "The work is complete." },
        { channel: "msteams" },
      ),
    ).toBeUndefined();
    expect(registered.logger.info).toHaveBeenCalledOnce();
  });

  it("documents a wording-only retry that cannot repeat side effects", () => {
    const config = normalizeEgressGuardConfig({
      mode: "enforce",
      finalOutput: { mode: "always", style: "plain", maxEmojis: 0 },
    });
    const instruction = buildFinalRevisionInstruction(config);
    expect(instruction).toContain("Do not call tools or repeat any side effect");
    expect(instruction).toContain("Do not use emojis");
    expect(instruction).toContain("Do not use em dashes");
  });
});

describe("Velanir last-mile delivery guard", () => {
  it("cancels internal-only Slack output with metadata and no canned response", () => {
    const registered = registerPlugin({ mode: "enforce" });
    const result = registered.hook("message_sending")(
      {
        content:
          "The internal model used the hidden config and session id before returning tool logs.",
      },
      { channelId: "slack" },
    );
    expect(result).toEqual({
      cancel: true,
      cancelReason: "velanir_egress_guard_suppressed",
      metadata: {
        egressGuard: expect.objectContaining({
          decision: "suppress",
          reasons: ["internal_mechanics"],
          outputLength: 0,
        }),
      },
    });
    expect(JSON.stringify(result)).not.toContain("I couldn't complete");
  });

  it("rewrites safe Teams output without touching unrelated channels", () => {
    const registered = registerPlugin({ mode: "enforce" });
    expect(
      registered.hook("message_sending")(
        { content: "Approved — ready ✅ 🎉" },
        { channelId: "msteams" },
      ),
    ).toEqual({ content: "Approved - ready ✅" });
    expect(
      registered.hook("message_sending")(
        { content: "Approved — ready ✅ 🎉" },
        { channelId: "telegram" },
      ),
    ).toBeUndefined();
  });
});
