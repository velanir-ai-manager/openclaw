import { describe, expect, it } from "vitest";
import type { ManagedIdentityLinks } from "../src/identity.js";
import { sanitizeIdentityPerspective } from "../src/perspective.js";

const identity: ManagedIdentityLinks = {
  selfName: "Alex Rivera",
  recipientName: "Morgan Lee",
  recipientRole: "manager",
  providerUserIds: { msteams: ["manager-123"] },
};

describe("identity perspective", () => {
  it("always corrects the speaking coworker to first person", () => {
    expect(
      sanitizeIdentityPerspective("Alex has a reply in Alex's inbox.", identity, false),
    ).toEqual({
      content: "I have a reply in my inbox.",
      changed: true,
      violation: false,
    });
  });

  it("uses second person only for a verified recipient", () => {
    expect(
      sanitizeIdentityPerspective("Morgan's calendar has the meeting.", identity, true),
    ).toMatchObject({
      content: "your calendar has the meeting.",
      changed: true,
      violation: false,
    });
    expect(
      sanitizeIdentityPerspective("Morgan's calendar has the meeting.", identity, false),
    ).toEqual({
      content: "Morgan's calendar has the meeting.",
      changed: false,
      violation: false,
    });
  });

  it("does not rewrite quoted source text", () => {
    expect(
      sanitizeIdentityPerspective("The note says “Alex has replied.” I agree.", identity, true),
    ).toEqual({
      content: "The note says “Alex has replied.” I agree.",
      changed: false,
      violation: false,
    });
  });

  it("blocks unresolved self references outside quotes", () => {
    expect(
      sanitizeIdentityPerspective("Alex completed the review.", identity, false),
    ).toMatchObject({
      violation: true,
    });
  });
});
