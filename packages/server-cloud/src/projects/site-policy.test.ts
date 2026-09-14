import { describe, expect, it } from "vitest";
import { projectSiteContentSecurityPolicy } from "./site-policy.js";

describe("project site framing policy", () => {
  it("allows published sites to render only inside the Harness asset library", () => {
    const policy = projectSiteContentSecurityPolicy(false);
    expect(policy).toContain("frame-ancestors https://harness.daoyintech.com");
    expect(policy).not.toContain("https://www.daoyintech.com");
    expect(policy).not.toContain("frame-ancestors 'none'");
  });
  it("keeps the existing authenticated preview parents", () => {
    expect(projectSiteContentSecurityPolicy(true)).toContain(
      "frame-ancestors https://harness.daoyintech.com https://www.daoyintech.com",
    );
  });
});
