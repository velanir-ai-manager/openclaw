import assert from "node:assert/strict";
import { test } from "vitest";
import { toolScopeFromContext, turnScopeFromContext } from "../src/index.js";
import {
  buildInjectionBlock,
  canonicalizeConversationId,
  filterForTurn,
} from "../src/injection.js";
import type { PendingInteraction } from "../src/types.js";

function item(overrides: Partial<PendingInteraction>): PendingInteraction {
  return {
    interactionId: "SM-1",
    stateVersion: "v1",
    stage: "awaiting_confirmation",
    responsibilityId: "schedule-meetings",
    sessionKey: "agent:main:msteams:direct:user-yash",
    conversationId: "user-yash",
    summary: "Sync with Dana",
    offeredSlots: [{ start: "2026-07-15T13:00:00-07:00", display: "Tue Jul 15 1:00–1:30 PM PT" }],
    source: "s1",
    ...overrides,
  };
}

test("injection is scoped to the matching agent, channel, and user", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: "user-yash" }),
  ];
  const shown = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(shown.length, 1);

  const wrongAgent = filterForTurn(
    items,
    {
      agentId: "other",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(wrongAgent.length, 0);

  const wrongChannel = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "slack",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(wrongChannel.length, 0);
});

test("one user's pending items never leak into another user's chat", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: "user-alice" }),
    item({ interactionId: "B", agentId: "main", channel: "msteams", userId: "user-bob" }),
  ];
  const forAlice = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-alice",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.deepEqual(
    forAlice.map((i) => i.interactionId),
    ["A"],
  );

  const forBob = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-bob",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.deepEqual(
    forBob.map((i) => i.interactionId),
    ["B"],
  );
});

test("item scoped to a user is hidden when the turn has no user (fail closed)", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: "user-alice" }),
  ];
  const noUserTurn = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(noUserTurn.length, 0);
});

test("strictUserScope hides interactions with no userId from user-scoped chats", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: undefined }),
  ];
  const strict = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(strict.length, 0);
  const loose = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "user-yash",
    },
    { strictUserScope: false, strictSessionScope: true },
  );
  assert.equal(loose.length, 1);
});

test("the same Teams user in another DM or group cannot see the interaction", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: "user-yash" }),
  ];
  const wrongSession = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:group:other-chat",
      conversationId: "other-chat",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(wrongSession.length, 0);
});

test("an exact session key is authoritative when hook conversation ids use another representation", () => {
  const items = [
    item({ interactionId: "A", agentId: "main", channel: "msteams", userId: "user-yash" }),
  ];
  const shown = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:direct:user-yash",
      conversationId: "graph-chat-id-for-the-same-dm",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(shown.length, 1);
});

test("conversation id is the exact fallback when no session key is stored", () => {
  const items = [
    item({
      interactionId: "A",
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: undefined,
      conversationId: "graph-chat-id",
    }),
  ];
  const shown = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: "agent:main:msteams:group:another-session-shape",
      conversationId: "graph-chat-id",
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.equal(shown.length, 1);
});

test("conversation fallback canonicalizes OpenClaw route prefixes without changing native colons", () => {
  const conversationId = "19:meeting_abc@thread.v2";
  assert.equal(canonicalizeConversationId(conversationId, "msteams"), conversationId);
  assert.equal(
    canonicalizeConversationId(`conversation:${conversationId}`, "msteams"),
    conversationId,
  );
  assert.equal(
    canonicalizeConversationId(`msteams:conversation:${conversationId}`, "msteams"),
    conversationId,
  );

  const items = [
    item({
      interactionId: "A",
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: undefined,
      conversationId,
    }),
  ];
  const shown = filterForTurn(
    items,
    {
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      conversationId: `conversation:${conversationId}`,
    },
    { strictUserScope: true, strictSessionScope: true },
  );
  assert.deepEqual(
    shown.map((candidate) => candidate.interactionId),
    ["A"],
  );
});

test("hook and tool contexts produce the same conversation-only scope", () => {
  const groupId = "19:meeting_abc@thread.v2";
  const hookGroup = turnScopeFromContext({
    agentId: "main",
    channel: "msteams",
    chatId: groupId,
    senderId: "user-yash",
  });
  const toolGroup = toolScopeFromContext({
    agentId: "main",
    messageChannel: "msteams",
    requesterSenderId: "user-yash",
    deliveryContext: { to: `conversation:${groupId}` },
  });
  assert.equal(hookGroup.conversationId, groupId);
  assert.equal(toolGroup.conversationId, hookGroup.conversationId);

  const hookDm = turnScopeFromContext({ channel: "msteams", chatId: "aad-yash" });
  const toolDm = toolScopeFromContext({
    messageChannel: "msteams",
    deliveryContext: { to: "user:aad-yash" },
  });
  assert.equal(toolDm.conversationId, hookDm.conversationId);
});

test("strict session scope hides an item with no exact session or conversation", () => {
  const items = [
    item({
      interactionId: "A",
      agentId: "main",
      channel: "msteams",
      userId: "user-yash",
      sessionKey: undefined,
      conversationId: undefined,
    }),
  ];
  const turn = {
    agentId: "main",
    channel: "msteams",
    userId: "user-yash",
    sessionKey: "agent:main:msteams:direct:user-yash",
    conversationId: "user-yash",
  };
  assert.equal(
    filterForTurn(items, turn, { strictUserScope: true, strictSessionScope: true }).length,
    0,
  );
  assert.equal(
    filterForTurn(items, turn, { strictUserScope: true, strictSessionScope: false }).length,
    1,
  );
});

test("empty in-scope set produces no injection text", () => {
  const block = buildInjectionBlock([], { maxChars: 1800, maxItems: 6 });
  assert.equal(block, "");
});
