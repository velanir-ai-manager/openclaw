import assert from "node:assert/strict";
import { test } from "vitest";
import { selectInteraction } from "../src/interactions.js";
import {
  SCOPED_EMPTY_PENDING_TEXT,
  TOOL_CONTRACTS,
  buildIndex,
  runChangeTool,
  runPendingTool,
  runRejectTool,
  runSelectOptionTool,
  runStatusTool,
} from "../src/tools.js";
import type { PendingInteraction, ToolError } from "../src/types.js";

function item(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    interactionId: "SM-1",
    stateVersion: "v1",
    stage: "awaiting_confirmation",
    responsibilityId: "schedule-meetings",
    summary: "Sync with Dana",
    offeredSlots: [
      {
        id: "slot-1",
        number: 1,
        start: "2026-07-15T13:00:00-07:00",
        display: "Tue Jul 15 1:00–1:30 PM PT",
      },
      {
        id: "slot-2",
        number: 2,
        start: "2026-07-15T15:00:00-07:00",
        display: "Tue Jul 15 3:00–3:30 PM PT",
      },
    ],
    source: "s1",
    ...overrides,
  };
}

const boundSelect = {
  interactionId: "SM-1",
  optionId: "1",
  // Inserted by index.ts only after it consumes the trusted inbound binding.
  userMessageId: "msg-42",
};

test("responsibility_pending is first; model-facing actions never accept a message id", () => {
  assert.deepEqual(
    TOOL_CONTRACTS.map((contract) => contract.name),
    [
      "responsibility_pending",
      "responsibility_select_option",
      "responsibility_reject",
      "responsibility_change",
      "responsibility_status",
    ],
  );
  assert.equal(TOOL_CONTRACTS[0].readOnly, true);
  for (const contract of TOOL_CONTRACTS.slice(1, 4)) {
    assert.equal(contract.parameters.properties.userMessageId, undefined);
    assert.equal(contract.parameters.additionalProperties, false);
  }
});

test("empty pending is explicitly scoped and cannot prove a lifecycle claim", () => {
  const result = runPendingTool(buildIndex([]));
  assert.equal(result.pendingCount, 0);
  assert.equal(result.visibility, "authenticated_session");
  assert.equal(result.absenceProof, "scoped_only");
  assert.equal(result.stopAfterThisTool, true);
  assert.equal(result.userVisibleText, SCOPED_EMPTY_PENDING_TEXT);
});

test("stable option selection accepts a displayed number and returns a dry-run result", () => {
  const result = runSelectOptionTool(buildIndex([item()]), boundSelect, true);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.dryRun, true);
  assert.equal(result.action, "select_option");
  assert.equal(result.accepted.optionId, "slot-1");
  assert.equal(result.accepted.userMessageId, undefined);
});

test("selecting without the internally bound inbound message fails closed", () => {
  const result = runSelectOptionTool(
    buildIndex([item()]),
    { interactionId: "SM-1", optionId: "slot-1" },
    true,
  );
  assert.equal(result.ok, false);
  assert.equal((result as ToolError).error, "missing_user_message_id");
});

test("selection cannot use an unoffered option or terminal interaction", () => {
  const unknown = runSelectOptionTool(
    buildIndex([item()]),
    { ...boundSelect, optionId: "slot-nope" },
    true,
  );
  assert.equal(unknown.ok, false);
  assert.equal((unknown as ToolError).error, "slot_not_offered");

  const terminal = runSelectOptionTool(
    buildIndex([item({ stage: "scheduled" })]),
    boundSelect,
    true,
  );
  assert.equal(terminal.ok, false);
  assert.equal((terminal as ToolError).error, "action_not_allowed_for_stage");
});

test("reject/change retain stale-version guards after trusted binding", () => {
  const index = buildIndex([item({ stage: "needs_info", offeredSlots: [] })]);
  const stale = runRejectTool(
    index,
    {
      interactionId: "SM-1",
      stateVersion: "old",
      reason: "not now",
      userMessageId: "msg-42",
    },
    true,
  );
  assert.equal(stale.ok, false);
  assert.equal((stale as ToolError).error, "state_version_mismatch");

  const change = runChangeTool(
    index,
    {
      interactionId: "SM-1",
      stateVersion: "v1",
      requestedWindow: "next week",
      userMessageId: "msg-42",
    },
    true,
  );
  assert.equal(change.ok, true);
  if (change.ok) {
    assert.equal(change.wouldTransitionTo, "needs_info");
  }
});

test("multiple pending interactions cannot be auto-bound", () => {
  const result = selectInteraction(
    buildIndex([item({ interactionId: "A" }), item({ interactionId: "B" })]),
    undefined,
  );
  assert.equal(result.ok, false);
  assert.equal((result as ToolError).error, "ambiguous_requires_interaction_id");
});

test("status stays read-only and exposes the current authoritative state", () => {
  const result = runStatusTool(buildIndex([item()]), { interactionId: "SM-1" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.stateVersion, "v1");
  }
});
