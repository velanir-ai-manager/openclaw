import assert from "node:assert/strict";
import { test } from "vitest";
import {
  executeAuthoritativeAction,
  loadPendingFromSource,
  loadPendingFromSources,
  mapRawItem,
} from "../src/source.js";
import type { RunnerExec } from "../src/source.js";
import type { ResponsibilitySource } from "../src/types.js";

function source(overrides: Partial<ResponsibilitySource> = {}): ResponsibilitySource {
  return {
    id: "sched",
    responsibilityId: "schedule-meetings-from-email",
    agentId: "main",
    workspacePath: "/tmp/ws",
    command: ["node", "runner.mjs", "pending"],
    timeoutMs: 5000,
    maxOutputBytes: 262144,
    channel: "msteams",
    userId: "user-yash",
    sessionKey: "agent:main:msteams:direct:user-yash",
    accountId: "riley",
    conversationId: "user-yash",
    ...overrides,
  };
}

const referenceRunnerOutput = JSON.stringify({
  ok: true,
  pendingCount: 1,
  pending: [
    {
      threadKey: "AAConversation123",
      stage: "awaiting_confirmation",
      subject: "Sync with Dana",
      counterpart: "dana@example.com",
      candidateSlots: [
        { start: "2026-07-15T13:00:00-07:00", display: "Tue Jul 15 1:00–1:30 PM PT" },
      ],
      note: "detected a conflict at the requested time",
    },
  ],
  hint: "Bind the user's reply to exactly one of these threads.",
});

test("maps the reference runner's pending output (threadKey/subject/candidateSlots)", () => {
  const exec: RunnerExec = () => ({ ok: true, stdout: referenceRunnerOutput });
  const { items } = loadPendingFromSource(source(), exec);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.interactionId, "AAConversation123");
  assert.equal(it.stage, "awaiting_confirmation");
  assert.equal(it.summary, "Sync with Dana");
  assert.equal(it.offeredSlots.length, 1);
  // Scope inherited from the source config.
  assert.equal(it.agentId, "main");
  assert.equal(it.channel, "msteams");
  assert.equal(it.userId, "user-yash");
  assert.equal(it.sessionKey, "agent:main:msteams:direct:user-yash");
  assert.equal(it.accountId, "riley");
  assert.equal(it.conversationId, "user-yash");
  // A deterministic stateVersion is synthesized when the runner omits one.
  assert.ok(it.stateVersion.length > 0);
});

test("synthesized stateVersion changes when interaction state changes", () => {
  const a = mapRawItem(
    {
      threadKey: "T",
      stage: "awaiting_confirmation",
      subject: "S",
      candidateSlots: [{ start: "x", display: "x" }],
    },
    source(),
  )!;
  const b = mapRawItem(
    { threadKey: "T", stage: "needs_info", subject: "S", candidateSlots: [] },
    source(),
  )!;
  assert.notEqual(a.stateVersion, b.stateVersion);
});

test("explicit interactionId/stateVersion from the runner are preferred", () => {
  const raw = {
    interactionId: "INT-9",
    stateVersion: "srv-v7",
    stage: "awaiting_confirmation",
    summary: "S",
    offeredSlots: [{ start: "x", display: "x" }],
  };
  const it = mapRawItem(raw, source())!;
  assert.equal(it.interactionId, "INT-9");
  assert.equal(it.stateVersion, "srv-v7");
});

test("maps Riley numberedSlots and changes synthesized version when the delivered ask changes", () => {
  const raw = {
    threadKey: "T-numbered",
    stage: "awaiting_confirmation",
    subject: "Planning sync",
    lastAskedToUser: "Which slot works? Reply 1 or 2.",
    numberedSlots: [
      { number: 1, start: "2026-07-15T13:00:00-07:00", label: "1 PM PT" },
      { id: "slot-2", value: "2026-07-15T15:00:00-07:00", display: "3 PM PT" },
    ],
  };
  const first = mapRawItem(raw, source())!;
  const changedAsk = mapRawItem(
    { ...raw, lastAskedToUser: "Pick 1 or 2 for Thursday." },
    source(),
  )!;
  assert.deepEqual(first.offeredSlots, [
    { id: "1", number: 1, start: "2026-07-15T13:00:00-07:00", display: "1 PM PT" },
    { id: "slot-2", start: "2026-07-15T15:00:00-07:00", display: "3 PM PT" },
  ]);
  assert.equal(first.lastAskedToUser, "Which slot works? Reply 1 or 2.");
  assert.notEqual(first.stateVersion, changedAsk.stateVersion);
});

test("maps packaged runner facts[].payload.pending with stable option ids", () => {
  const exec: RunnerExec = () => ({
    ok: true,
    stdout: JSON.stringify({
      ok: true,
      mode: "pending",
      facts: [
        {
          kind: "pending",
          payload: {
            pendingCount: 1,
            pending: [
              {
                interactionId: "interaction-dana",
                stateVersion: 7,
                stage: "awaiting_manager_selection",
                lastAskedToUser: "Which slot works? Reply 1 or 2.",
                counterpart: "dana@example.com",
                numberedSlots: [
                  {
                    number: 2,
                    optionId: "slot-2",
                    value: { startsAt: "2026-07-15T15:00:00-07:00", durationMinutes: 30 },
                    display: "3:00-3:30 PM PT",
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
  });

  const { items, error } = loadPendingFromSource(source(), exec);
  assert.equal(error, undefined);
  assert.equal(items.length, 1);
  assert.equal(items[0].interactionId, "interaction-dana");
  assert.equal(items[0].stateVersion, "7");
  assert.equal(items[0].summary, "dana@example.com");
  assert.equal(items[0].lastAskedToUser, "Which slot works? Reply 1 or 2.");
  assert.deepEqual(items[0].offeredSlots, [
    {
      id: "slot-2",
      number: 2,
      start: "2026-07-15T15:00:00-07:00",
      display: "3:00-3:30 PM PT",
    },
  ]);
});

test("maps the typed workflow pending shape and keeps configured delivery scope authoritative", () => {
  const it = mapRawItem(
    {
      id: "typed-1",
      stateVersion: 9,
      stage: "awaiting_manager_selection",
      responsibilityId: "untrusted-other-responsibility",
      agentId: "other",
      managerUserId: "runner-user",
      channel: "slack",
      sessionKey: "agent:other:slack:direct:runner-user",
      conversationId: "runner-conversation",
      options: [{ id: "slot-1", value: "2026-07-15T13:00:00-07:00", label: "1 PM PT" }],
      delivery: { messageId: "message-1" },
    },
    source({ accountId: undefined }),
  )!;

  assert.equal(it.interactionId, "typed-1");
  assert.equal(it.userId, "user-yash");
  assert.equal(it.agentId, "main");
  assert.equal(it.channel, "msteams");
  assert.equal(it.sessionKey, "agent:main:msteams:direct:user-yash");
  assert.equal(it.conversationId, "user-yash");
  assert.equal(it.accountId, undefined);
  assert.equal(it.deliveryMessageId, "message-1");
  assert.deepEqual(it.offeredSlots, [
    {
      id: "slot-1",
      start: "2026-07-15T13:00:00-07:00",
      display: "1 PM PT",
    },
  ]);
});

test("normalizes numeric runner stateVersion tokens", () => {
  const it = mapRawItem({ interactionId: "INT-10", stateVersion: 7 }, source())!;
  assert.equal(it.stateVersion, "7");
});

test("items with no stable id are dropped", () => {
  const it = mapRawItem({ stage: "awaiting_confirmation", subject: "no id" }, source());
  assert.equal(it, null);
});

test("a failed exec yields no items and a recorded error (fail-safe, never throws)", () => {
  const exec: RunnerExec = () => ({ ok: false, error: "runner_exec_failed: ETIMEDOUT" });
  const { items, error } = loadPendingFromSource(source(), exec);
  assert.equal(items.length, 0);
  assert.match(error ?? "", /runner_exec_failed/);
});

test("truncated output is refused, not parsed (size cap safety)", () => {
  const exec: RunnerExec = () => ({
    ok: true,
    stdout: referenceRunnerOutput.slice(0, 40),
    truncated: true,
  });
  const { items, error } = loadPendingFromSource(source(), exec);
  assert.equal(items.length, 0);
  assert.equal(error, "output_truncated");
});

test("unparseable output is refused", () => {
  const exec: RunnerExec = () => ({ ok: true, stdout: "gateway log line: not json" });
  const { items, error } = loadPendingFromSource(source(), exec);
  assert.equal(items.length, 0);
  assert.equal(error, "unparseable_pending_output");
});

test("JSON embedded in log noise is still recovered", () => {
  const noisy = `2026-07-10 booting runner...\n${referenceRunnerOutput}\n`;
  const exec: RunnerExec = () => ({ ok: true, stdout: noisy });
  const { items } = loadPendingFromSource(source(), exec);
  assert.equal(items.length, 1);
});

test("multiple sources aggregate and errors are keyed by source id", () => {
  const ok: RunnerExec = () => ({ ok: true, stdout: referenceRunnerOutput });
  const bad: RunnerExec = () => ({ ok: false, error: "boom" });
  const okSources = loadPendingFromSources([source({ id: "a" })], ok);
  assert.equal(okSources.items.length, 1);
  const mixed = loadPendingFromSources([source({ id: "a" })], bad);
  assert.equal(mixed.items.length, 0);
  assert.equal(mixed.errors.a, "boom");
});

test("authoritative action has no implicit command and sends trusted input only on stdin", () => {
  let calls = 0;
  const request = {
    action: "select_option" as const,
    interactionId: "INT-1",
    stateVersion: "7",
    userMessageId: "trusted-message",
    optionId: "slot-1",
    authorization: {
      senderId: "yash",
      sessionKey: "agent:main:msteams:direct:yash",
      messageId: "trusted-message",
    },
  };
  const unavailable = executeAuthoritativeAction(source(), request, () => {
    calls += 1;
    return { ok: true, stdout: "{}" };
  });
  assert.equal(unavailable.ok, false);
  assert.equal(calls, 0);

  const configured = source({
    actionCommand: ["node", "runner.mjs", "authoritative-action"],
    actionTimeoutMs: 50_000,
  });
  const completed = executeAuthoritativeAction(configured, request, (input) => {
    calls += 1;
    assert.deepEqual(input.command, ["node", "runner.mjs", "authoritative-action"]);
    assert.match(input.stdin ?? "", /trusted-message/);
    assert.doesNotMatch(input.command.join(" "), /trusted-message/);
    return {
      ok: true,
      stdout: JSON.stringify({ ok: true, action: "select_option", status: "scheduled" }),
    };
  });
  assert.equal(completed.ok, true);
  assert.equal(calls, 1);
});
