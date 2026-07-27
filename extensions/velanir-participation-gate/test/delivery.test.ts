import { describe, expect, it } from "vitest";
import {
  createTurnDeliveryState,
  createTurnDeliveryStore,
  deliveryRouteForInbound,
  deliveryScopeForInbound,
  deliveryScopeForMessage,
  deliveryScopeForTool,
  sharedTurnDeliveryState,
} from "../src/delivery.js";
import type { DeliveryConfig } from "../src/types.js";

const baseConfig: DeliveryConfig = {
  mode: "coalesce",
  quietWindowMs: 45_000,
  maxProgressMessages: 0,
  progressText: "Still working on this.",
  turnTtlMs: 600_000,
};

function storeWithClock(overrides: Partial<DeliveryConfig> = {}) {
  let currentTime = 1_000;
  const store = createTurnDeliveryStore(
    { ...baseConfig, ...overrides },
    () => currentTime,
    createTurnDeliveryState(),
  );
  return {
    store,
    advance(ms: number) {
      currentTime += ms;
    },
  };
}

const teamsEvent = {
  provider: "msteams",
  channel: "19:room@thread.tacv2",
  sessionKey: "agent:main:msteams:conversation:19:room@thread.tacv2",
  senderId: "user-yash",
};

const teamsCtx = {
  provider: "msteams",
  conversationId: "conversation:19:room@thread.tacv2",
  channelId: "19:room@thread.tacv2",
  sessionKey: "agent:main:msteams:conversation:19:room@thread.tacv2",
  senderId: "user-yash",
};

describe("delivery scopes", () => {
  it("prefers the exact session key for inbound scope", () => {
    expect(deliveryScopeForInbound(teamsEvent, teamsCtx)).toBe(
      "session:agent:main:msteams:conversation:19:room@thread.tacv2",
    );
  });

  it("falls back to provider+conversation, then channel, when no session key exists", () => {
    expect(
      deliveryScopeForInbound(
        { provider: "msteams" },
        { conversationId: "conversation:19:x@thread.tacv2" },
      ),
    ).toBe("conversation:msteams:conversation:19:x@thread.tacv2");
    expect(deliveryScopeForInbound({ provider: "msteams", channel: "19:x@thread.tacv2" }, {})).toBe(
      "channel:msteams:19:x@thread.tacv2",
    );
    expect(deliveryScopeForInbound({}, {})).toBeUndefined();
  });

  it("scopes tool calls by session key only", () => {
    expect(deliveryScopeForTool({ sessionKey: "s1" })).toBe("session:s1");
    expect(deliveryScopeForTool({})).toBeUndefined();
  });

  it("scopes message egress by session key with channel/conversation fallback", () => {
    expect(deliveryScopeForMessage({ sessionKey: "s1" })).toBe("session:s1");
    expect(deliveryScopeForMessage({ channelId: "c1", conversationId: "conv1" })).toBe(
      "channel:c1:conv1",
    );
  });

  it("captures the inbound conversation route", () => {
    expect(deliveryRouteForInbound(teamsEvent, teamsCtx)).toEqual({
      provider: "msteams",
      conversationId: "conversation:19:room@thread.tacv2",
      channelId: "19:room@thread.tacv2",
      senderId: "user-yash",
    });
  });
});

describe("turn delivery store", () => {
  const scope = deliveryScopeForInbound(teamsEvent, teamsCtx);
  const route = deliveryRouteForInbound(teamsEvent, teamsCtx);

  function replyEvent(kind: "tool" | "block" | "final" | undefined, runId = "run-1") {
    return {
      kind,
      channel: "msteams",
      sessionKey: teamsCtx.sessionKey,
      runId,
      payload: { text: "payload text" },
    };
  }

  it("suppresses non-final reply payloads for a tracked turn", () => {
    const { store } = storeWithClock();
    store.beginTurn(scope, route);

    const decision = store.decide(replyEvent("tool"), teamsCtx);

    expect(decision.action).toBe("suppress_intermediate");
    expect(decision.result).toEqual({
      cancel: true,
      reason: "participation_gate_suppressed_intermediate",
    });
  });

  it("admits exactly one final and cancels the duplicate final path", () => {
    const { store } = storeWithClock();
    store.beginTurn(scope, route);

    expect(store.decide(replyEvent("final"), teamsCtx).action).toBe("allow_final");
    const duplicate = store.decide(replyEvent("final"), teamsCtx);
    expect(duplicate.action).toBe("suppress_duplicate_final");
    expect(duplicate.result).toEqual({
      cancel: true,
      reason: "participation_gate_duplicate_final",
    });
  });

  it("treats a payload without kind as a legacy final", () => {
    const { store } = storeWithClock();
    store.beginTurn(scope, route);

    expect(store.decide(replyEvent(undefined), teamsCtx).action).toBe("allow_final");
  });

  it("cancels a repeat final for the same runId even after a new turn begins", () => {
    const { store } = storeWithClock();
    store.beginTurn(scope, route);
    expect(store.decide(replyEvent("final", "run-1"), teamsCtx).action).toBe("allow_final");

    store.beginTurn(scope, route);
    expect(store.decide(replyEvent("final", "run-1"), teamsCtx).action).toBe(
      "suppress_duplicate_final",
    );
  });

  it("cancels progress payloads when maxProgressMessages is 0", () => {
    const { store, advance } = storeWithClock({ maxProgressMessages: 0 });
    store.beginTurn(scope, route);
    advance(60_000);

    const decision = store.decide(replyEvent("tool"), teamsCtx);

    expect(decision.action).toBe("suppress_intermediate");
  });

  it("allows one generic progress payload after the quiet window when configured", () => {
    const { store, advance } = storeWithClock({ maxProgressMessages: 1 });
    store.beginTurn(scope, route);

    expect(store.decide(replyEvent("tool"), teamsCtx).action).toBe("suppress_intermediate");
    advance(45_000);

    const allowed = store.decide(replyEvent("tool"), teamsCtx);
    expect(allowed.action).toBe("allow_progress");
    expect(allowed.result?.payload).toEqual({
      text: baseConfig.progressText,
      isStatusNotice: true,
    });

    expect(store.decide(replyEvent("tool"), teamsCtx).action).toBe("suppress_intermediate");
  });

  it("replaces progress content and keeps only reply-threading fields", () => {
    const { store, advance } = storeWithClock({ maxProgressMessages: 1 });
    store.beginTurn(scope, route);
    advance(45_000);

    const allowed = store.decide(
      {
        kind: "tool" as const,
        channel: "msteams",
        sessionKey: teamsCtx.sessionKey,
        runId: "run-1",
        payload: {
          text: "Let me check the calendar now...",
          replyToId: "message-9",
          replyToTag: true,
          replyToCurrent: true,
          internalDetail: "secret",
        },
      },
      teamsCtx,
    );

    expect(allowed.action).toBe("allow_progress");
    expect(allowed.result?.payload).toEqual({
      text: baseConfig.progressText,
      isStatusNotice: true,
      replyToId: "message-9",
      replyToTag: true,
      replyToCurrent: true,
    });
  });

  it("allows untracked replies (no turn) untouched", () => {
    const { store } = storeWithClock();

    const decision = store.decide(replyEvent("final"), teamsCtx);

    expect(decision.action).toBe("allow_untracked");
    expect(decision.result).toBeUndefined();
  });

  it("expires turn and run state after the TTL", () => {
    const { store, advance } = storeWithClock({ turnTtlMs: 10_000 });
    store.beginTurn(scope, route);
    expect(store.decide(replyEvent("final", "run-1"), teamsCtx).action).toBe("allow_final");

    advance(10_001);

    expect(store.activeTurnCount()).toBe(0);
    expect(store.decide(replyEvent("final", "run-1"), teamsCtx).action).toBe("allow_untracked");
  });

  it("abandons a turn explicitly", () => {
    const { store } = storeWithClock();
    store.beginTurn(scope, route);
    expect(store.abandonTurn(scope)).toBe(true);
    expect(store.decide(replyEvent("final"), teamsCtx).action).toBe("allow_untracked");
  });

  describe("same-conversation send detection", () => {
    it("matches sends whose target resolves to the active conversation", () => {
      const { store } = storeWithClock();
      store.beginTurn(scope, route);

      for (const target of [
        "conversation:19:room@thread.tacv2",
        "msteams:conversation:19:room@thread.tacv2",
        "19:room@thread.tacv2",
        "19:room@thread.tacv2;messageid=1779762397111",
        "user-yash",
      ]) {
        expect(store.isSameConversationSend(scope, { provider: "msteams", target })).toBe(true);
      }
    });

    it("treats a targetless send as same-conversation (cannot be proven unrelated)", () => {
      const { store } = storeWithClock();
      store.beginTurn(scope, route);

      expect(store.isSameConversationSend(scope, { provider: "msteams" })).toBe(true);
    });

    it("allows sends to unrelated destinations and other providers", () => {
      const { store } = storeWithClock();
      store.beginTurn(scope, route);

      expect(
        store.isSameConversationSend(scope, {
          provider: "msteams",
          target: "conversation:19:other@thread.tacv2",
        }),
      ).toBe(false);
      expect(
        store.isSameConversationSend(scope, {
          provider: "slack",
          target: "conversation:19:room@thread.tacv2",
        }),
      ).toBe(false);
    });

    it("does not flag sends when no turn is tracked for the scope", () => {
      const { store } = storeWithClock();

      expect(
        store.isSameConversationSend(scope, {
          provider: "msteams",
          target: "conversation:19:room@thread.tacv2",
        }),
      ).toBe(false);
      expect(
        store.isSameConversationSend(undefined, {
          provider: "msteams",
          target: "conversation:19:room@thread.tacv2",
        }),
      ).toBe(false);
    });
  });

  describe("final egress accounting", () => {
    it("permits exactly one direct message egress for an admitted final", () => {
      const { store } = storeWithClock();
      store.beginTurn(scope, route);

      expect(store.consumeFinalEgress(scope)).toBe(false);
      expect(store.decide(replyEvent("final"), teamsCtx).action).toBe("allow_final");
      expect(store.consumeFinalEgress(scope)).toBe(true);
      expect(store.consumeFinalEgress(scope)).toBe(false);
    });
  });
});

describe("sharedTurnDeliveryState", () => {
  it("returns the same state across register calls", () => {
    const first = sharedTurnDeliveryState();
    const second = sharedTurnDeliveryState();
    expect(first).toBe(second);
  });
});
