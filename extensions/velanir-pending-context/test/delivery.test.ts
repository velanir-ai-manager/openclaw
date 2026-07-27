import assert from "node:assert/strict";
import { test } from "vitest";
import {
  claimsSchedulingSuccess,
  createTransactionDeliveryState,
  createTransactionDeliveryStore,
} from "../src/delivery.js";

function successfulReceipt() {
  return {
    ok: true,
    dryRun: false,
    action: "select_option",
    status: "scheduled",
    userVisibleText: "The meeting is scheduled for Tuesday at 1 PM.",
    result: { eventId: "evt-1", joinUrl: "https://zoom.us/j/1", replied: true },
  };
}

test("only a tracked pending run is quiet; ordinary chat is unaffected", () => {
  const store = createTransactionDeliveryStore(10_000, Date.now, createTransactionDeliveryState());
  assert.equal(store.suppressNonFinal({ runId: "ordinary", kind: "tool" }), false);
  store.markPendingTurn("pending-run", "session-a");
  assert.equal(store.suppressNonFinal({ runId: "pending-run", kind: "tool" }), true);
  assert.equal(store.suppressNonFinal({ runId: "pending-run", kind: "final" }), false);
});

test("one authoritative receipt produces one exact final and blocks later tools", () => {
  const store = createTransactionDeliveryStore(10_000, Date.now, createTransactionDeliveryState());
  store.markPendingTurn("run-1", "session-a");
  assert.deepEqual(
    store.beginAction(
      { toolName: "responsibility_select_option", runId: "run-1", toolCallId: "call-1" },
      {
        sessionKey: "session-a",
      },
    ),
    { tracked: true, duplicate: false },
  );
  assert.equal(
    store.finishAction(
      {
        toolName: "responsibility_select_option",
        runId: "run-1",
        toolCallId: "call-1",
        result: successfulReceipt(),
      },
      { sessionKey: "session-a" },
    ),
    true,
  );
  assert.equal(store.blockFurtherTool({ runId: "run-1", toolCallId: "call-2" }, {}), true);
  assert.equal(
    store.authoritativeFinalForSession("session-a", true),
    "The meeting is scheduled for Tuesday at 1 PM.",
  );
  assert.equal(store.markFinalDelivered("session-a"), true);
  assert.equal(store.finalAlreadyDelivered("session-a"), true);
});

test("a scheduling-success claim without an action is rewritten to a truthful failure", () => {
  const store = createTransactionDeliveryStore(10_000, Date.now, createTransactionDeliveryState());
  store.markPendingTurn("run-1", "session-a");
  assert.equal(claimsSchedulingSuccess("Done — I scheduled the meeting."), true);
  assert.equal(claimsSchedulingSuccess("I could not schedule the meeting."), false);
  assert.match(
    store.authoritativeFinalForSession("session-a", true) ?? "",
    /didn't complete a scheduling transaction/i,
  );
  assert.equal(store.authoritativeFinalForSession("session-a", false), undefined);
});

test("a dry-run result never becomes a scheduling success claim", () => {
  const store = createTransactionDeliveryStore(10_000, Date.now, createTransactionDeliveryState());
  store.markPendingTurn("run-1", "session-a");
  store.beginAction(
    { toolName: "responsibility_select_option", runId: "run-1", toolCallId: "call-1" },
    {
      sessionKey: "session-a",
    },
  );
  store.finishAction(
    {
      toolName: "responsibility_select_option",
      runId: "run-1",
      toolCallId: "call-1",
      result: { ok: true, dryRun: true, action: "select_option" },
    },
    { sessionKey: "session-a" },
  );
  assert.match(store.expectedFinalText("run-1") ?? "", /dry-run mode/i);
});
