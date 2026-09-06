import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessLogo } from "./HarnessLogo.js";

describe("selected Aurora Fold resource", () => {
  it("uses the shared image resource and preserves accessible image attributes", () => {
    const html = renderToStaticMarkup(createElement(HarnessLogo, { "aria-hidden": true }));
    expect(html).toContain("harness-logo.png");
    expect(html).toContain('class="harness-logo"');
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<svg");
  });
});
