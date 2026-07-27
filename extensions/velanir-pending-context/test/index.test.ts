import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createInboundAuthorizationState,
  createInboundAuthorizationStore,
} from "../src/authorization.js";
import { createTransactionDeliveryState, createTransactionDeliveryStore } from "../src/delivery.js";
import { registerPendingContextPlugin } from "../src/index.js";
import type { RunnerExec } from "../src/source.js";

function pendingOutput() {
  return JSON.stringify({
    ok: true,
    pending: [
      {
        interactionId: "meeting-1",
        stateVersion: "v3",
        stage: "awaiting_confirmation",
        summary: "Sync with Dana",
        offeredSlots: [
          {
            optionId: "slot-1",
            number: 1,
            start: "2026-07-15T13:00:00-07:00",
            display: "Tuesday 1 PM",
          },
        ],
      },
    ],
  });
}

test("plugin keeps ordinary chat unmodified and finalizes one trusted pending action", async () => {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const toolFactories: Array<
    (ctx: Record<string, unknown>) => {
      name: string;
      execute: (id: string, params: unknown) => Promise<{ details: unknown }>;
    }
  > = [];
  let policy: { evaluate: (event: unknown, ctx: unknown) => unknown } | undefined;
  const api = {
    pluginConfig: {
      dryRun: true,
      suppressNonFinalReplies: true,
      sources: [
        {
          id: "meetings",
          responsibilityId: "meetings",
          workspacePath: "/tmp/meetings",
          agentId: "main",
          channel: "msteams",
          userId: "yash",
          sessionKey: "agent:main:msteams:direct:yash",
        },
      ],
    },
    logger: {},
    registerTool(tool: unknown) {
      toolFactories.push(
        tool as (ctx: Record<string, unknown>) => {
          name: string;
          execute: (id: string, params: unknown) => Promise<{ details: unknown }>;
        },
      );
    },
    registerTrustedToolPolicy(value: unknown) {
      policy = value as { evaluate: (event: unknown, ctx: unknown) => unknown };
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      hooks.set(name, handler);
    },
  };
  const exec: RunnerExec = () => ({ ok: true, stdout: pendingOutput() });
  let now = 1_000;
  registerPendingContextPlugin(api as never, exec, {
    authorization: createInboundAuthorizationStore(
      10_000,
      () => now,
      createInboundAuthorizationState(),
    ),
    delivery: createTransactionDeliveryStore(10_000, () => now, createTransactionDeliveryState()),
  });

  hooks.get("message_received")?.(
    {
      messageId: "teams-inbound-1",
      senderId: "msteams:user:Yash",
      sessionKey: "agent:main:msteams:direct:yash",
      runId: "run-pending",
    },
    { channelId: "msteams", sessionKey: "agent:main:msteams:direct:yash" },
  );

  const prepared = hooks.get("agent_turn_prepare")?.(
    {},
    {
      runId: "run-pending",
      agentId: "main",
      channel: "msteams",
      senderId: "yash",
      sessionKey: "agent:main:msteams:direct:yash",
    },
  ) as { appendContext?: string } | undefined;
  assert.match(prepared?.appendContext ?? "", /meeting-1/);

  assert.equal(
    policy?.evaluate(
      {
        toolName: "responsibility_select_option",
        toolCallId: "call-1",
        runId: "run-pending",
        params: { interactionId: "meeting-1", optionId: "slot-1" },
      },
      { sessionKey: "agent:main:msteams:direct:yash" },
    ),
    undefined,
  );

  const selectFactory = toolFactories.find(
    (factory) =>
      factory({
        agentId: "main",
        messageChannel: "msteams",
        requesterSenderId: "yash",
        sessionKey: "agent:main:msteams:direct:yash",
      }).name === "responsibility_select_option",
  );
  assert.ok(selectFactory);
  const tool = selectFactory!({
    agentId: "main",
    messageChannel: "msteams",
    requesterSenderId: "yash",
    sessionKey: "agent:main:msteams:direct:yash",
  });
  const action = await tool.execute("call-1", { interactionId: "meeting-1", optionId: "slot-1" });
  assert.match(JSON.stringify(action.details), /dry-run mode/i);

  const suppressed = hooks.get("reply_payload_sending")?.(
    {
      kind: "tool",
      runId: "run-pending",
      sessionKey: "agent:main:msteams:direct:yash",
      payload: { text: "checking the calendar" },
    },
    {},
  );
  assert.deepEqual(suppressed, { cancel: true, reason: "pending_context_suppressed_non_final" });

  const persisted = hooks.get("before_message_write")?.(
    {
      sessionKey: "agent:main:msteams:direct:yash",
      message: { role: "assistant", content: "Done — I scheduled it." },
    },
    {},
  );
  assert.match(JSON.stringify(persisted), /dry-run mode/i);

  const final = hooks.get("reply_payload_sending")?.(
    {
      kind: "final",
      sessionKey: "agent:main:msteams:direct:yash",
      payload: { text: "Done — I scheduled it." },
    },
    {},
  );
  assert.match(JSON.stringify(final), /dry-run mode/i);
  const duplicate = hooks.get("reply_payload_sending")?.(
    {
      kind: "final",
      sessionKey: "agent:main:msteams:direct:yash",
      payload: { text: "A second final" },
    },
    {},
  );
  assert.deepEqual(duplicate, { cancel: true, reason: "pending_context_duplicate_final" });

  now += 1;
  const ordinary = hooks.get("reply_payload_sending")?.(
    {
      kind: "tool",
      runId: "ordinary-run",
      sessionKey: "agent:main:msteams:direct:ordinary",
      payload: { text: "ordinary tool update" },
    },
    {},
  );
  assert.equal(ordinary, undefined);
});
