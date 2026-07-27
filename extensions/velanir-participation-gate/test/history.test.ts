import { describe, expect, it } from "vitest";
import { createParticipationHistoryStore } from "../src/history.js";

describe("participation history", () => {
  it("keeps recent messages by conversation and respects maxMessages", () => {
    const history = createParticipationHistoryStore();
    const ctx = { conversationId: "C1" };

    history.record({ isGroup: true, body: "first", senderId: "U1" }, ctx, 2);
    history.record({ isGroup: true, body: "second", senderId: "U2" }, ctx, 2);
    history.record({ isGroup: true, body: "third", senderId: "U3" }, ctx, 2);

    expect(history.recent({ isGroup: true, body: "current" }, ctx, 2)).toEqual([
      { role: "user", senderId: "U2", content: "second" },
      { role: "user", senderId: "U3", content: "third" },
    ]);
  });

  it("does not record empty messages", () => {
    const history = createParticipationHistoryStore();
    const ctx = { conversationId: "C1" };

    history.record({ isGroup: true, body: "   ", senderId: "U1" }, ctx, 2);

    expect(history.recent({ isGroup: true, body: "current" }, ctx, 2)).toEqual([]);
  });

  it("records successful outbound replies as assistant context", () => {
    const history = createParticipationHistoryStore();

    history.recordOutbound(
      {
        to: "conversation:19:random@thread.tacv2",
        content: "San Francisco is 61F.",
        success: true,
      },
      {},
      5,
    );
    history.recordOutbound(
      { to: "conversation:19:random@thread.tacv2", content: "failed reply", success: false },
      {},
      5,
    );

    expect(
      history.recent(
        { isGroup: true, body: "which one is your favorite?", channel: "19:random@thread.tacv2" },
        { conversationId: "19:random@thread.tacv2" },
        5,
      ),
    ).toEqual([
      {
        role: "assistant",
        senderId: "self",
        senderName: "This coworker",
        content: "San Francisco is 61F.",
      },
    ]);
  });

  it("matches Teams thread reply targets to later inbound thread turns", () => {
    const history = createParticipationHistoryStore();

    history.recordOutbound(
      {
        to: "conversation:19:random@thread.tacv2;messageid=1779762397111",
        content: "Palo Alto is sunny.",
        success: true,
      },
      {},
      5,
    );

    expect(
      history.recent(
        {
          isGroup: true,
          provider: "msteams",
          channel: "19:random@thread.tacv2",
          messageThreadId: "1779762397111",
          body: "which one is your favorite?",
        },
        { conversationId: "conversation:19:random@thread.tacv2" },
        5,
      ),
    ).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Palo Alto is sunny.",
      }),
    ]);
  });

  it("records raw Teams text instead of the thread-history envelope", () => {
    const history = createParticipationHistoryStore();
    const ctx = { conversationId: "19:random@thread.tacv2" };

    history.record(
      {
        isGroup: true,
        rawBody: "What about Palo Alto?",
        body: "[Thread history]\nDan: Bill, weather in San Francisco?\nBill Gates: 61F\n[/Thread history]\n\nWhat about Palo Alto?",
        senderId: "U1",
      },
      ctx,
      5,
    );

    expect(history.recent({ isGroup: true, body: "current" }, ctx, 5)).toEqual([
      expect.objectContaining({
        role: "user",
        content: "What about Palo Alto?",
      }),
    ]);
  });
});
