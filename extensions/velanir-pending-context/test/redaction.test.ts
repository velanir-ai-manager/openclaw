import assert from "node:assert/strict";
import { test } from "vitest";
import { buildInjectionBlock } from "../src/injection.js";
import { redactText, containsSensitive } from "../src/redaction.js";
import { mapRawItem } from "../src/source.js";
import { buildIndex, runStatusTool } from "../src/tools.js";
import type { ResponsibilitySource } from "../src/types.js";

const source: ResponsibilitySource = {
  id: "sched",
  responsibilityId: "schedule-meetings-from-email",
  agentId: "riley",
  workspacePath: "/tmp/ws",
  command: ["node", "runner.mjs", "pending"],
  timeoutMs: 5000,
  maxOutputBytes: 262144,
  channel: "msteams",
  userId: "user-yash",
};

test("redactText strips connection ids, api keys, bearer tokens, and reasoning tags", () => {
  const dirty =
    "action conn_mod_def::GJ58yZcBb7E::M-xAriMUQoKq3UO_5nbqBA key ak_abcdef123456 " +
    "Bearer sk_live_9f8e7d Authorization live::deadbeef <think>secret plan</think> mm:think";
  const clean = redactText(dirty);
  assert.doesNotMatch(clean, /conn_mod_def/);
  assert.doesNotMatch(clean, /ak_abcdef/);
  assert.doesNotMatch(clean, /live::deadbeef/);
  assert.doesNotMatch(clean, /<think>/);
  assert.doesNotMatch(clean, /mm:think/);
  assert.match(clean, /\[redacted\]/);
});

test("mapped interaction summary/note never carry provider residue", () => {
  const it = mapRawItem(
    {
      threadKey: "T1",
      stage: "awaiting_confirmation",
      subject: "Sync ak_SECRETKEY123 with conn_mod_def::X::Y",
      candidateSlots: [{ start: "2026-07-15T13:00:00-07:00", display: "Tue 1pm" }],
      note: "used Bearer sk_live_abcdef to fetch",
    },
    source,
  )!;
  assert.ok(!containsSensitive(it.summary), `summary leaked: ${it.summary}`);
  assert.ok(!containsSensitive(it.note ?? ""), `note leaked: ${it.note}`);
});

test("injection block and status result contain no credentials", () => {
  const it = mapRawItem(
    {
      threadKey: "T1",
      stage: "awaiting_confirmation",
      subject: "conn_mod_def::A::B leaked subject",
      candidateSlots: [{ start: "2026-07-15T13:00:00-07:00", display: "Tue 1pm ak_key123456" }],
    },
    source,
  )!;
  const block = buildInjectionBlock([it], { maxChars: 1800, maxItems: 6 });
  assert.ok(!containsSensitive(block), `injection leaked: ${block}`);

  const status = runStatusTool(buildIndex([it]), { interactionId: "T1" });
  assert.ok(status.ok);
  assert.ok(!containsSensitive(JSON.stringify(status)), "status leaked");
});
