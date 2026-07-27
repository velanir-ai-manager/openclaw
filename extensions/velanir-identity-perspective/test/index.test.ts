import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

const tempDirs: string[] = [];

async function identityFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "identity-perspective-"));
  tempDirs.push(dir);
  const file = path.join(dir, "AGENTS.md");
  await writeFile(
    file,
    `<!-- OCT8_IDENTITY_LINKS_START -->
- Alex Rivera is you.
| Person | Relationship | Provider identities |
| --- | --- | --- |
| Morgan Lee | manager | msteams/user-id: manager-123 |
<!-- OCT8_IDENTITY_LINKS_END -->`,
    "utf8",
  );
  return file;
}

describe("identity perspective plugin", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rewrites the verified recipient while keeping another recipient in third person", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const logger = { info: vi.fn(), warn: vi.fn() };
    plugin.register({
      pluginConfig: {
        identityFile: await identityFile(),
        channels: ["msteams"],
      },
      logger,
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        hooks.set(name, handler);
      },
    } as never);

    const send = hooks.get("message_sending");
    expect(send).toBeDefined();
    expect(
      await send?.(
        {
          to: "manager-123",
          content: "Alex has checked Morgan's calendar.",
          metadata: { channel: "msteams" },
        },
        { channelId: "msteams" },
      ),
    ).toEqual({ content: "I have checked your calendar." });
    expect(
      await send?.(
        {
          to: "another-user",
          content: "Alex has checked Morgan's calendar.",
          metadata: { channel: "msteams" },
        },
        { channelId: "msteams" },
      ),
    ).toEqual({ content: "I have checked Morgan's calendar." });
  });

  it("rejects machine-relative identity paths", () => {
    expect(() =>
      plugin.register({
        pluginConfig: { identityFile: "workspace/AGENTS.md" },
        logger: { info: vi.fn(), warn: vi.fn() },
        on: vi.fn(),
      } as never),
    ).toThrow("identityFile must be an absolute path");
  });
});
