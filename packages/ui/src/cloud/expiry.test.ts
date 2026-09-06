import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleExpiry } from "./expiry.js";

describe("account expiry scheduling", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a 30-day account active past the browser timer limit and expires exactly once", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    scheduleExpiry(Date.now() + 30 * 86_400_000, expire);
    vi.advanceTimersByTime(2_147_483_647);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * 86_400_000 - 2_147_483_647 - 1);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the rescheduled timer when the connection changes", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const cancel = scheduleExpiry(Date.now() + 30 * 86_400_000, expire);
    vi.advanceTimersByTime(2_147_483_647);
    cancel();
    vi.advanceTimersByTime(30 * 86_400_000);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains short visitor expiry and handles already elapsed deadlines", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    scheduleExpiry(Date.now() + 60_000, expire);
    vi.advanceTimersByTime(59_999);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledOnce();
    scheduleExpiry(Date.now() - 1, expire);
    expect(expire).toHaveBeenCalledTimes(2);
  });
});
