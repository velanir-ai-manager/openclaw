import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

const { default: plugin } = await import("../src/index.js");
type PluginApiParam = Parameters<typeof plugin.register>[0];
type BeforeDispatchHook = (event: unknown, ctx: unknown) => Promise<unknown>;
type MessageSentHook = (event: unknown, ctx: unknown) => unknown;
type ReplyPayloadSendingHook = (event: unknown, ctx: unknown) => unknown;
type BeforeToolCallHook = (event: unknown, ctx: unknown) => unknown;
type MessageSendingHook = (event: unknown, ctx: unknown) => unknown;
type HookByName = {
  before_dispatch: BeforeDispatchHook;
  message_sent: MessageSentHook;
  reply_payload_sending: ReplyPayloadSendingHook;
  before_tool_call: BeforeToolCallHook;
  message_sending: MessageSendingHook;
};

const PRE_EGRESS_DELIVERY_PRIORITY = 100_000;
const POST_EGRESS_REPLY_CAPTURE_PRIORITY = -100_001;

const staticContext = {
  self: { id: "albus", names: ["Albus"] },
  coworkers: [],
};

function apiForMode(
  mode: "shadow" | "enforce",
  pluginConfigOverrides: Record<string, unknown> = {},
) {
  return {
    pluginConfig: {
      mode,
      classifier: { provider: "test", model: "test" },
      context: { source: "static", maxMessages: 2 },
      staticContext,
      logging: { decisions: true },
      ...pluginConfigOverrides,
    },
    config: {},
    logger: { info: vi.fn() },
    runtime: {
      agent: {
        runEmbeddedPiAgent: vi.fn().mockResolvedValue({
          payloads: [{ text: '{ "participationScore": 0.2 }' }],
        }),
      },
    },
    on: vi.fn(),
  };
}

function resetSharedDeliveryState() {
  delete (globalThis as Record<string, unknown>)["__velanirParticipationGateDeliveryV1"];
}

describe("plugin entry", () => {
  function hookFor<TName extends keyof HookByName>(
    api: ReturnType<typeof apiForMode>,
    name: TName,
    priority?: number,
  ): HookByName[TName] {
    const handler = api.on.mock.calls.find(
      (call) =>
        call[0] === name &&
        (priority === undefined ||
          (call[2] as { priority?: number } | undefined)?.priority === priority),
    )?.[1];
    if (!handler) {
      throw new Error(`missing ${name} hook`);
    }
    return handler as HookByName[TName];
  }

  it("registers the before_dispatch, message_sent, and reply_payload_sending hooks", () => {
    const api = apiForMode("shadow");

    plugin.register(api as unknown as PluginApiParam);

    expect(api.on).toHaveBeenCalledWith("before_dispatch", expect.any(Function), {
      timeoutMs: 7000,
    });
    expect(api.on).toHaveBeenCalledWith("message_sent", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), {
      priority: -100001,
    });
  });

  it("does not suppress skipped decisions in shadow mode", async () => {
    const api = apiForMode("shadow");
    plugin.register(api as unknown as PluginApiParam);
    const handler = hookFor(api, "before_dispatch");

    await expect(
      handler(
        { isGroup: true, body: "What should we do?", senderId: "U1" },
        { conversationId: "C1" },
      ),
    ).resolves.toBeUndefined();
  });

  it("bypasses the participation gate when the event was already mentioned", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const handler = hookFor(api, "before_dispatch");

    await expect(
      handler(
        { isGroup: true, body: "What should we do?", senderId: "U1", wasMentioned: true },
        { conversationId: "C1" },
      ),
    ).resolves.toBeUndefined();

    expect(api.runtime.agent.runEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("velanir-participation-gate-history: event=mention_bypass_inbound"),
    );
  });

  it("bypasses the participation gate when the context was already mentioned", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const handler = hookFor(api, "before_dispatch");

    await expect(
      handler(
        { isGroup: true, body: "What should we do?", senderId: "U1" },
        { conversationId: "C1", wasMentioned: true },
      ),
    ).resolves.toBeUndefined();

    expect(api.runtime.agent.runEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("velanir-participation-gate-history: event=mention_bypass_inbound"),
    );
  });

  it("suppresses skipped decisions in enforce mode", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const handler = hookFor(api, "before_dispatch");

    await expect(
      handler(
        { isGroup: true, body: "What should we do?", senderId: "U1" },
        { conversationId: "C1" },
      ),
    ).resolves.toEqual({ handled: true });
  });

  it("keeps mentioned inbound and successful sent replies for later Teams classifier context", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const beforeDispatch = hookFor(api, "before_dispatch");
    const messageSent = hookFor(api, "message_sent");

    await beforeDispatch(
      {
        isGroup: true,
        provider: "msteams",
        channel: "19:random@thread.tacv2",
        messageThreadId: "1779762397111",
        rawBody: "Albus, what is the weather in San Francisco?",
        senderId: "U1",
        senderName: "Dan",
        wasMentioned: true,
      },
      { conversationId: "conversation:19:random@thread.tacv2" },
    );
    messageSent(
      {
        to: "conversation:19:random@thread.tacv2;messageid=1779762397111",
        content: "San Francisco is 61F.",
        success: true,
      },
      {},
    );

    await beforeDispatch(
      {
        isGroup: true,
        provider: "msteams",
        channel: "19:random@thread.tacv2",
        messageThreadId: "1779762397111",
        rawBody: "What about Palo Alto?",
        senderId: "U1",
        senderName: "Dan",
      },
      { conversationId: "conversation:19:random@thread.tacv2" },
    );

    const classifierPrompt = api.runtime.agent.runEmbeddedPiAgent.mock.calls[0]?.[0]?.prompt;
    expect(classifierPrompt).toContain("user Dan: Albus, what is the weather in San Francisco?");
    expect(classifierPrompt).toContain("assistant This coworker: San Francisco is 61F.");
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("velanir-participation-gate-history: event=message_sent_outbound"),
    );
  });

  it("records final reply payloads as assistant context for later Slack follow-ups", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const beforeDispatch = hookFor(api, "before_dispatch");
    const replyPayloadSending = hookFor(
      api,
      "reply_payload_sending",
      POST_EGRESS_REPLY_CAPTURE_PRIORITY,
    );

    await beforeDispatch(
      {
        isGroup: true,
        provider: "slack",
        channel: "C123",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
        rawBody: "Albus, which customers are coming up for renewal in July?",
        senderId: "U1",
        senderName: "Dan",
      },
      {
        channelId: "C123",
        conversationId: "C123",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
      },
    );
    replyPayloadSending(
      {
        kind: "final",
        channel: "slack",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
        runId: "run-1",
        payload: {
          text: "Found 4 customers with contracts expiring in July.",
        },
      },
      {
        channelId: "C123",
        conversationId: "C123",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
        runId: "run-1",
      },
    );

    await beforeDispatch(
      {
        isGroup: true,
        provider: "slack",
        channel: "C123",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
        rawBody: "We need to schedule a renewal meeting with all three.",
        senderId: "U1",
        senderName: "Dan",
      },
      {
        channelId: "C123",
        conversationId: "C123",
        sessionKey: "agent:main:slack:C123:thread:1782137348.213179",
      },
    );

    const classifierPrompt = api.runtime.agent.runEmbeddedPiAgent.mock.calls[0]?.[0]?.prompt;
    expect(classifierPrompt).toContain(
      "user Dan: Albus, which customers are coming up for renewal in July?",
    );
    expect(classifierPrompt).toContain(
      "assistant This coworker: Found 4 customers with contracts expiring in July.",
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("velanir-participation-gate-history: event=reply_payload_outbound"),
    );
  });

  it("dedupes reply payload and message_sent outbound history for the same final answer", async () => {
    const api = apiForMode("enforce");
    plugin.register(api as unknown as PluginApiParam);
    const beforeDispatch = hookFor(api, "before_dispatch");
    const messageSent = hookFor(api, "message_sent");
    const replyPayloadSending = hookFor(
      api,
      "reply_payload_sending",
      POST_EGRESS_REPLY_CAPTURE_PRIORITY,
    );

    replyPayloadSending(
      {
        kind: "final",
        channel: "slack",
        sessionKey: "agent:main:slack:C123",
        runId: "run-1",
        payload: { text: "Which date should I use?" },
      },
      {
        channelId: "C123",
        conversationId: "C123",
        sessionKey: "agent:main:slack:C123",
        runId: "run-1",
      },
    );
    messageSent(
      {
        to: "C123",
        content: "Which date should I use?",
        success: true,
        messageId: "slack-message-1",
      },
      { channelId: "C123", conversationId: "C123", sessionKey: "agent:main:slack:C123" },
    );

    await beforeDispatch(
      {
        isGroup: true,
        provider: "slack",
        channel: "C123",
        sessionKey: "agent:main:slack:C123",
        rawBody: "Lets go with July 15",
        senderName: "Dan",
      },
      { channelId: "C123", conversationId: "C123", sessionKey: "agent:main:slack:C123" },
    );

    const classifierPrompt = api.runtime.agent.runEmbeddedPiAgent.mock.calls[0]?.[0]
      ?.prompt as string;
    expect(
      classifierPrompt.match(/assistant This coworker: Which date should I use\?/g),
    ).toHaveLength(1);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "velanir-participation-gate-history: event=reply_payload_outbound recorded=true",
      ),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "velanir-participation-gate-history: event=message_sent_outbound recorded=false",
      ),
    );
  });
});

describe("turn delivery coalescer hooks", () => {
  const SESSION_KEY = "agent:main:msteams:conversation:19:room@thread.tacv2";
  const CONVERSATION_ID = "conversation:19:room@thread.tacv2";
  const OTHER_CONVERSATION_ID = "conversation:19:other@thread.tacv2";

  const inboundEvent = {
    isGroup: true,
    provider: "msteams",
    channel: "19:room@thread.tacv2",
    sessionKey: SESSION_KEY,
    rawBody: "Albus, can you check my calendar?",
    senderId: "user-yash",
    senderName: "Yash",
    wasMentioned: true,
  };

  const inboundCtx = {
    provider: "msteams",
    channelId: "19:room@thread.tacv2",
    conversationId: CONVERSATION_ID,
    sessionKey: SESSION_KEY,
    senderId: "user-yash",
  };

  function coalesceApi(deliveryOverrides: Record<string, unknown> = {}) {
    resetSharedDeliveryState();
    const api = apiForMode("enforce", {
      delivery: { mode: "coalesce", maxProgressMessages: 0, ...deliveryOverrides },
    });
    plugin.register(api as unknown as PluginApiParam);
    return api;
  }

  function hookFor<TName extends keyof HookByName>(
    api: ReturnType<typeof apiForMode>,
    name: TName,
    priority?: number,
  ): HookByName[TName] {
    const handler = api.on.mock.calls.find(
      (call) =>
        call[0] === name &&
        (priority === undefined ||
          (call[2] as { priority?: number } | undefined)?.priority === priority),
    )?.[1];
    if (!handler) {
      throw new Error(`missing ${name} hook`);
    }
    return handler as HookByName[TName];
  }

  function replyEvent(kind: "tool" | "block" | "final" | undefined, runId = "run-1") {
    return {
      kind,
      channel: "msteams",
      sessionKey: SESSION_KEY,
      runId,
      payload: { text: "some model output" },
    };
  }

  const replyCtx = {
    channelId: "19:room@thread.tacv2",
    conversationId: CONVERSATION_ID,
    sessionKey: SESSION_KEY,
    runId: "run-1",
  };

  it("registers the delivery hooks at the pre-egress priority", () => {
    const api = coalesceApi();

    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function), {
      priority: PRE_EGRESS_DELIVERY_PRIORITY,
    });
    expect(api.on).toHaveBeenCalledWith("message_sending", expect.any(Function), {
      priority: PRE_EGRESS_DELIVERY_PRIORITY,
    });
    expect(api.on).toHaveBeenCalledWith("reply_payload_sending", expect.any(Function), {
      priority: PRE_EGRESS_DELIVERY_PRIORITY,
    });
  });

  it("suppresses non-final reply payloads for a tracked turn", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(deliveryReply(replyEvent("tool"), replyCtx)).toEqual({
      cancel: true,
      reason: "participation_gate_suppressed_intermediate",
    });
    expect(deliveryReply(replyEvent("block"), replyCtx)).toEqual({
      cancel: true,
      reason: "participation_gate_suppressed_intermediate",
    });
  });

  it("cancels progress narration when maxProgressMessages is 0, regardless of elapsed time", async () => {
    const api = coalesceApi({ maxProgressMessages: 0, quietWindowMs: 0 });
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(deliveryReply(replyEvent("tool"), replyCtx)).toEqual({
      cancel: true,
      reason: "participation_gate_suppressed_intermediate",
    });
  });

  it("admits exactly one final and cancels duplicate finals", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(deliveryReply(replyEvent("final"), replyCtx)).toBeUndefined();
    expect(deliveryReply(replyEvent("final"), replyCtx)).toEqual({
      cancel: true,
      reason: "participation_gate_duplicate_final",
    });
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("action=allow_final"));
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("action=suppress_duplicate_final"),
    );
  });

  it("blocks a message.send tool call targeting the active conversation before execution", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const beforeToolCall = hookFor(api, "before_tool_call");

    await beforeDispatch(inboundEvent, inboundCtx);

    const result = beforeToolCall(
      {
        toolName: "message",
        params: { action: "send", provider: "msteams", to: CONVERSATION_ID },
        runId: "run-1",
        toolCallId: "tc-1",
      },
      { sessionKey: SESSION_KEY, runId: "run-1" },
    );

    expect(result).toEqual({
      block: true,
      blockReason:
        "Use the normal final reply for this conversation. Direct message sends to the active conversation are blocked.",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "action=block_same_conversation_message_tool run=run-1 toolCall=tc-1",
      ),
    );
  });

  it("allows message.send to an unrelated destination and non-message tools", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const beforeToolCall = hookFor(api, "before_tool_call");

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(
      beforeToolCall(
        {
          toolName: "message",
          params: { action: "send", provider: "msteams", to: OTHER_CONVERSATION_ID },
        },
        { sessionKey: SESSION_KEY },
      ),
    ).toBeUndefined();
    expect(
      beforeToolCall(
        {
          toolName: "message",
          params: { action: "send", provider: "slack", to: CONVERSATION_ID },
        },
        { sessionKey: SESSION_KEY },
      ),
    ).toBeUndefined();
    expect(
      beforeToolCall({ toolName: "exec", params: { command: "ls" } }, { sessionKey: SESSION_KEY }),
    ).toBeUndefined();
    expect(
      beforeToolCall(
        { toolName: "message", params: { action: "list" } },
        { sessionKey: SESSION_KEY },
      ),
    ).toBeUndefined();
  });

  it("allows a proactive message.send from a session with no tracked inbound turn", () => {
    const api = coalesceApi();
    const beforeToolCall = hookFor(api, "before_tool_call");

    expect(
      beforeToolCall(
        {
          toolName: "message",
          params: { action: "send", provider: "msteams", to: CONVERSATION_ID },
        },
        { sessionKey: "agent:main:cron:responsibility-tick" },
      ),
    ).toBeUndefined();
  });

  it("suppresses direct message egress for the active conversation unless it is the admitted final", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);
    const messageSending = hookFor(api, "message_sending");

    await beforeDispatch(inboundEvent, inboundCtx);

    const sendEvent = { to: CONVERSATION_ID, metadata: { channel: "msteams" } };
    const sendCtx = {
      sessionKey: SESSION_KEY,
      conversationId: CONVERSATION_ID,
      channelId: "19:room@thread.tacv2",
    };

    // No admitted final yet: direct outbound to the conversation is cancelled.
    expect(messageSending(sendEvent, sendCtx)).toEqual({
      cancel: true,
      cancelReason: "participation_gate_suppressed_same_conversation_message",
    });

    // Admit the final through the coalescer, then its egress passes exactly once.
    expect(deliveryReply(replyEvent("final"), replyCtx)).toBeUndefined();
    expect(messageSending(sendEvent, sendCtx)).toBeUndefined();
    expect(messageSending(sendEvent, sendCtx)).toEqual({
      cancel: true,
      cancelReason: "participation_gate_suppressed_same_conversation_message",
    });
  });

  it("allows message egress to unrelated destinations while a turn is active", async () => {
    const api = coalesceApi();
    const beforeDispatch = hookFor(api, "before_dispatch");
    const messageSending = hookFor(api, "message_sending");

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(
      messageSending(
        { to: OTHER_CONVERSATION_ID, metadata: { channel: "msteams" } },
        { sessionKey: "agent:main:cron:responsibility-tick" },
      ),
    ).toBeUndefined();
  });

  it("passthrough mode is a delivery no-op", async () => {
    resetSharedDeliveryState();
    const api = apiForMode("enforce", {
      delivery: { mode: "passthrough", maxProgressMessages: 0 },
    });
    plugin.register(api as unknown as PluginApiParam);
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);
    const beforeToolCall = hookFor(api, "before_tool_call");
    const messageSending = hookFor(api, "message_sending");

    await beforeDispatch(inboundEvent, inboundCtx);

    expect(deliveryReply(replyEvent("tool"), replyCtx)).toBeUndefined();
    expect(deliveryReply(replyEvent("final"), replyCtx)).toBeUndefined();
    expect(deliveryReply(replyEvent("final"), replyCtx)).toBeUndefined();
    expect(
      beforeToolCall(
        {
          toolName: "message",
          params: { action: "send", provider: "msteams", to: CONVERSATION_ID },
        },
        { sessionKey: SESSION_KEY },
      ),
    ).toBeUndefined();
    expect(
      messageSending(
        { to: CONVERSATION_ID, metadata: { channel: "msteams" } },
        { sessionKey: SESSION_KEY, conversationId: CONVERSATION_ID },
      ),
    ).toBeUndefined();
    expect(api.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("action=begin_turn"));
  });

  it("does not begin a delivery turn for a suppressed (enforce-skipped) inbound message", async () => {
    resetSharedDeliveryState();
    const api = apiForMode("enforce", {
      delivery: { mode: "coalesce", maxProgressMessages: 0 },
    });
    plugin.register(api as unknown as PluginApiParam);
    const beforeDispatch = hookFor(api, "before_dispatch");
    const deliveryReply = hookFor(api, "reply_payload_sending", PRE_EGRESS_DELIVERY_PRIORITY);

    // Classifier score 0.2 < 0.7 threshold and not mentioned: turn is skipped.
    await expect(
      beforeDispatch(
        { ...inboundEvent, rawBody: "What should we do?", wasMentioned: undefined },
        { ...inboundCtx, wasMentioned: undefined },
      ),
    ).resolves.toEqual({ handled: true });

    expect(deliveryReply(replyEvent("tool"), replyCtx)).toBeUndefined();
  });
});
