import assert from "node:assert/strict";
import { test } from "vitest";
import { buildInjectionBlock } from "../src/injection.js";
import type { PendingInteraction } from "../src/types.js";

function item(i: number, overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    interactionId: `SM-${i}`,
    stateVersion: `v${i}`,
    stage: "awaiting_confirmation",
    responsibilityId: "schedule-meetings",
    agentId: "riley",
    channel: "msteams",
    userId: "user-yash",
    summary: `Sync number ${i}`,
    offeredSlots: [
      { start: "2026-07-15T13:00:00-07:00", display: "Tue Jul 15 1:00–1:30 PM PT" },
      { start: "2026-07-15T15:00:00-07:00", display: "Tue Jul 15 3:00–3:30 PM PT" },
    ],
    source: "s1",
    ...overrides,
  };
}

test("injection block lists multiple pending interactions with ids and stateVersions", () => {
  const block = buildInjectionBlock([item(1), item(2)], { maxChars: 1800, maxItems: 6 });
  assert.match(block, /\[pending responsibility interactions\]/);
  assert.match(block, /2 pending responsibility interactions/);
  assert.match(block, /id=SM-1 · v=v1/);
  assert.match(block, /id=SM-2 · v=v2/);
  assert.match(block, /call responsibility_pending/);
  assert.match(block, /responsibility_select_option/);
});

test("needs_info interaction with no slots renders an 'awaiting a preferred time' hint", () => {
  const block = buildInjectionBlock([item(1, { stage: "needs_info", offeredSlots: [] })], {
    maxChars: 1800,
    maxItems: 6,
  });
  assert.match(block, /awaiting a preferred time/);
  assert.doesNotMatch(block, /offered:/);
});

test("maxItems caps the number of listed lines and shows a '+N more' indicator", () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1));
  const block = buildInjectionBlock(items, { maxChars: 5000, maxItems: 3 });
  // Exactly three numbered item lines.
  const numbered = block.split("\n").filter((l) => /^\d+\. id=/.test(l));
  assert.equal(numbered.length, 3);
  assert.match(block, /\(\+7 more/);
});

test("size cap truncates the block and still fits under maxChars with a 'more' indicator", () => {
  const items = Array.from({ length: 20 }, (_, i) => item(i + 1));
  const cap = 700;
  const block = buildInjectionBlock(items, { maxChars: cap, maxItems: 20 });
  assert.ok(block.length <= cap, `block length ${block.length} should be <= ${cap}`);
  assert.match(block, /\(\+\d+ more/);
  // Header and footer survive truncation.
  assert.match(block, /\[pending responsibility interactions\]/);
  assert.match(block, /responsibility_select_option/);
});

test("schema-minimum fallback keeps the complete typed-action guard", () => {
  const block = buildInjectionBlock([item(1)], { maxChars: 200, maxItems: 6 });

  assert.ok(block.length <= 200, `block length ${block.length} should be <= 200`);
  assert.match(block, /responsibility_pending; bind one\./);
  assert.match(block, /responsibility_select_option/);
});

test("invalid sub-minimum cap fails closed instead of slicing safety text", () => {
  const block = buildInjectionBlock([item(1)], { maxChars: 100, maxItems: 6 });
  assert.equal(block, "");
});
