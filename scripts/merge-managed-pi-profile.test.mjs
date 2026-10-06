import { describe, expect, it } from "vitest";
import { mergeManagedPiPackages } from "./merge-managed-pi-profile.mjs";

const manifest = {
  packages: [{
    name: "pi-subagents",
    runtimeSource: "/opt/pi-web-managed-profile/npm/node_modules/pi-subagents",
  }],
};

describe("managed Railway Pi profile", () => {
  it("replaces another source for a managed package while preserving unrelated settings", () => {
    expect(mergeManagedPiPackages({
      defaultModel: "zai-org/GLM-5.3",
      packages: [
        "npm:pi-subagents@0.70.0",
        "npm:pi-web-access",
        { source: "npm:@acme/tools@1.2.3", extensions: ["tools.js"] },
      ],
    }, manifest)).toEqual({
      defaultModel: "zai-org/GLM-5.3",
      packages: [
        "npm:pi-web-access",
        { source: "npm:@acme/tools@1.2.3", extensions: ["tools.js"] },
        "/opt/pi-web-managed-profile/npm/node_modules/pi-subagents",
      ],
    });
  });

  it("keeps a single managed source across repeated startup reconciliation", () => {
    const first = mergeManagedPiPackages({}, manifest);
    expect(mergeManagedPiPackages(first, manifest)).toEqual(first);
  });

  it("rejects malformed durable settings rather than replacing them", () => {
    expect(() => mergeManagedPiPackages([], manifest)).toThrow("Pi settings must contain a JSON object");
  });
});
