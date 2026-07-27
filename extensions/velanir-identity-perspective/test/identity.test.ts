import { describe, expect, it } from "vitest";
import { matchesManagedRecipient, parseIdentityLinks } from "../src/identity.js";

const managed = `
<!-- OCT8_IDENTITY_LINKS_START -->
- Alex Rivera is you.
| Person | Relationship | Provider identities |
| --- | --- | --- |
| Morgan Lee | manager | msteams/user-id: manager-123; slack/user-id: U123 |
<!-- OCT8_IDENTITY_LINKS_END -->
`;

describe("managed identity links", () => {
  it("parses self, relationship, and provider user ids", () => {
    expect(parseIdentityLinks(managed)).toEqual({
      selfName: "Alex Rivera",
      recipientName: "Morgan Lee",
      recipientRole: "manager",
      providerUserIds: {
        msteams: ["manager-123"],
        slack: ["U123"],
      },
    });
  });

  it("matches only exact provider ids or reviewed channel targets", () => {
    const identity = parseIdentityLinks(managed);
    expect(matchesManagedRecipient(identity, "msteams", ["manager-123"])).toBe(true);
    expect(matchesManagedRecipient(identity, "msteams", ["manager-123-other"])).toBe(false);
    expect(
      matchesManagedRecipient(
        identity,
        "msteams",
        ["conversation-9"],
        [{ channel: "msteams", target: "conversation-9" }],
      ),
    ).toBe(true);
  });

  it("rejects missing managed boundaries", () => {
    expect(() => parseIdentityLinks("- Alex Rivera is you.")).toThrow(
      "managed identity links block is missing",
    );
  });
});
