import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createInboundAuthorizationState,
  createInboundAuthorizationStore,
} from "../src/authorization.js";

function scope(overrides: Record<string, string> = {}) {
  return {
    sessionKey: "agent:main:msteams:direct:yash",
    userId: "yash",
    ...overrides,
  };
}

test("trusted inbound authorization is exact-session, exact-user, and single-use", () => {
  let now = 1_000;
  const store = createInboundAuthorizationStore(
    10_000,
    () => now,
    createInboundAuthorizationState(),
  );
  assert.equal(
    store.recordInbound(
      {
        messageId: "teams-message-1",
        senderId: "msteams:user:Yash",
        sessionKey: "agent:main:msteams:direct:yash",
        runId: "run-1",
      },
      {},
    ),
    true,
  );
  assert.equal(store.hasFreshBinding(scope(), "run-1"), true);
  assert.equal(store.hasFreshBinding(scope({ userId: "other" }), "run-1"), false);
  assert.equal(
    store.hasFreshBinding(scope({ sessionKey: "agent:main:msteams:group:other" }), "run-1"),
    false,
  );

  assert.equal(
    store.bindTool(
      { toolName: "responsibility_select_option", toolCallId: "call-1", runId: "run-1" },
      {
        sessionKey: "agent:main:msteams:direct:yash",
      },
    ),
    true,
  );
  const first = store.consumeDetailed("call-1", scope());
  assert.equal(first.authorization?.messageId, "teams-message-1");

  assert.equal(
    store.bindTool(
      { toolName: "responsibility_select_option", toolCallId: "call-2", runId: "run-1" },
      {
        sessionKey: "agent:main:msteams:direct:yash",
      },
    ),
    true,
  );
  const replay = store.consumeDetailed("call-2", scope());
  assert.equal(replay.authorization, null);
  assert.equal(replay.error, "message_replayed");

  now += 10_001;
  assert.equal(store.hasFreshBinding(scope(), "run-1"), false);
});
