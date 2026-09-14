import { describe, expect, it } from "vitest";
import { keepReadyAfterBackgroundFailure } from "./connection-state.js";

describe("cloud workbench background connection state", () => {
  it("keeps an already loaded workbench ready after a transient identity check failure", () => {
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "account-a")).toBe(true);
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "account-a", 503)).toBe(true);
  });

  it("surfaces initial, account-changing, and authorization failures", () => {
    expect(keepReadyAfterBackgroundFailure(false, "account-a", "account-a", 503)).toBe(false);
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "", 503)).toBe(false);
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "account-b", 503)).toBe(false);
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "account-a", 401)).toBe(false);
    expect(keepReadyAfterBackgroundFailure(true, "account-a", "account-a", 403)).toBe(false);
  });
});
