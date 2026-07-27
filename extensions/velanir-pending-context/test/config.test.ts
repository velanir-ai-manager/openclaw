import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeConfig, CONFIG_DEFAULTS } from "../src/config.js";

test("defaults: dry-run, suppression, and exact user/session scoping ON", () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.dryRun, true);
  assert.equal(c.strictUserScope, true);
  assert.equal(c.strictSessionScope, true);
  assert.equal(c.suppressNonFinalReplies, true);
  assert.equal(c.maxInjectionChars, CONFIG_DEFAULTS.maxInjectionChars);
  assert.equal(c.maxItemsInInjection, CONFIG_DEFAULTS.maxItems);
  assert.deepEqual(c.sources, []);
});

test("dryRun only turns off on an explicit false", () => {
  assert.equal(normalizeConfig({ dryRun: "no" }).dryRun, true);
  assert.equal(normalizeConfig({ dryRun: 0 }).dryRun, true);
  assert.equal(normalizeConfig({ dryRun: false }).dryRun, false);
});

test("a source needs workspacePath and responsibilityId; others get defaults", () => {
  const c = normalizeConfig({
    sources: [
      {
        responsibilityId: "sched",
        workspacePath: "/tmp/ws",
        agentId: "main",
        channel: "msteams",
        userId: "u1",
        sessionKey: "agent:main:msteams:direct:u1",
        accountId: "riley",
        conversationId: "u1",
      },
      { workspacePath: "/tmp/only-ws" }, // dropped: no responsibilityId
      { responsibilityId: "x" }, // dropped: no workspacePath
    ],
  });
  assert.equal(c.sources.length, 1);
  const s = c.sources[0];
  assert.equal(s.responsibilityId, "sched");
  assert.deepEqual(s.command, [...CONFIG_DEFAULTS.command]);
  assert.equal(s.timeoutMs, CONFIG_DEFAULTS.timeoutMs);
  assert.equal(s.actionCommand, undefined);
  assert.equal(s.maxOutputBytes, CONFIG_DEFAULTS.maxOutputBytes);
  assert.equal(s.agentId, "main");
  assert.equal(s.sessionKey, "agent:main:msteams:direct:u1");
  assert.equal(s.accountId, "riley");
  assert.equal(s.conversationId, "u1");
});

test("custom command array is preserved; empty/invalid falls back to default", () => {
  const custom = normalizeConfig({
    sources: [
      { responsibilityId: "x", workspacePath: "/w", command: ["node", "r.mjs", "pending"] },
    ],
  });
  assert.deepEqual(custom.sources[0].command, ["node", "r.mjs", "pending"]);
  const empty = normalizeConfig({
    sources: [{ responsibilityId: "x", workspacePath: "/w", command: [] }],
  });
  assert.deepEqual(empty.sources[0].command, [...CONFIG_DEFAULTS.command]);
});

test("an action bridge is opt-in and has no default argv", () => {
  const absent = normalizeConfig({
    dryRun: false,
    sources: [{ responsibilityId: "x", workspacePath: "/w" }],
  });
  assert.equal(absent.dryRun, false);
  assert.equal(absent.sources[0].actionCommand, undefined);

  const configured = normalizeConfig({
    dryRun: false,
    sources: [
      {
        responsibilityId: "x",
        workspacePath: "/w",
        actionCommand: ["node", "runner.mjs", "authoritative-action"],
        actionTimeoutMs: 1234,
      },
    ],
  });
  assert.deepEqual(configured.sources[0].actionCommand, [
    "node",
    "runner.mjs",
    "authoritative-action",
  ]);
  assert.equal(configured.sources[0].actionTimeoutMs, 1234);
});

test("unknown top-level fields are dropped (config is rebuilt)", () => {
  const c = normalizeConfig({ dryRun: false, bogus: "x", sources: [] }) as Record<string, unknown>;
  assert.equal("bogus" in c, false);
});
