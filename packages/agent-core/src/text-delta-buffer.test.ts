import { afterEach, describe, expect, it, vi } from "vitest";
import { TextDeltaBuffer } from "./text-delta-buffer.js";

const buffers: TextDeltaBuffer[] = [];
function fixture(emit = vi.fn<(text: string) => Promise<void>>(async () => undefined)) {
  const controller = new AbortController();
  const failed = vi.fn();
  const buffer = new TextDeltaBuffer({ emit, signal: controller.signal, onFailure: failed });
  buffers.push(buffer);
  return { buffer, emit, controller, failed };
}
afterEach(async () => { for (const b of buffers.splice(0)) await b.discard(); vi.useRealTimers(); });

describe("bounded durable text blocks (no model/network)", () => {
  it("emits first content immediately, then coalesces thousands of tiny fragments", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.buffer.push("首");
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenCalledWith("首");
    for (let n = 0; n < 4000; n++) await f.buffer.push("x");
    await f.buffer.finish();
    expect(f.emit.mock.calls.map(([text]) => text).join("")).toBe("首" + "x".repeat(4000));
    expect(f.emit.mock.calls.length).toBeLessThan(8);
    expect(f.emit.mock.calls.every(([text]) => Buffer.byteLength(text) <= 2048)).toBe(true);
  });
  it("flushes pending content on the maximum timer delay", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.buffer.push("first"); await f.buffer.push("next");
    await vi.advanceTimersByTimeAsync(99); expect(f.emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.emit).toHaveBeenCalledTimes(2);
    await f.buffer.finish(); expect(f.emit).toHaveBeenCalledTimes(2);
  });
  it("preserves Unicode while splitting by UTF-8 bytes", async () => {
    const f = fixture(); const text = "🌏中文".repeat(1000);
    await f.buffer.push(text); await f.buffer.finish();
    expect(f.emit.mock.calls.map(([part]) => part).join("")).toBe(text);
    for (const [part] of f.emit.mock.calls) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(2048);
      expect(part.endsWith("\ud83c")).toBe(false);
    }
  });
  it("keeps a surrogate pair intact when the provider splits it across callbacks", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.buffer.push("\ud83c");
    expect(f.emit).not.toHaveBeenCalled();
    await f.buffer.push("\udf0f");
    await f.buffer.finish();
    expect(f.emit.mock.calls.map(([text]) => text).join("")).toBe("🌏");
  });
  it("discards unsaved text on abort and rejects later callbacks", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.buffer.push("saved"); await f.buffer.push("not saved");
    f.controller.abort(); await f.buffer.discard();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenCalledWith("saved");
    await expect(f.buffer.push("late")).rejects.toThrow();
  });
  it("drains an already-started write before cancellation may append a terminal event", async () => {
    vi.useFakeTimers(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const emit = vi.fn(async (text: string) => { if (text === "pending") await gate; });
    const f = fixture(emit);
    await f.buffer.push("first"); await f.buffer.push("pending");
    await vi.advanceTimersByTimeAsync(100);
    let drained = false; const closing = f.buffer.discard().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release(); await closing; expect(drained).toBe(true);
  });
  it("surfaces timer persistence failures instead of silently dropping them", async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn(async (text: string) => { if (text === "fail") throw new Error("storage failed"); }));
    await f.buffer.push("first"); await f.buffer.push("fail");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.failed).toHaveBeenCalledTimes(1);
    await expect(f.buffer.finish()).rejects.toThrow("storage failed");
  });
});
