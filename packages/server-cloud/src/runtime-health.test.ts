import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ReadinessProbe, runtimeBuild } from "./runtime-health.js";
import { RunMeasurements } from "./run-diagnostics.js";

describe("P0 read-only readiness and bounded diagnostics", () => {
  it("treats an absent probe as not ready", async () => {
    expect(await new ReadinessProbe(undefined).ready()).toBe(false);
  });
  it("coalesces simultaneous probes and caches success without repeated I/O", async () => {
    const check = vi.fn(async () => { await delay(1); });
    const probe = new ReadinessProbe(check, 100, 5000);
    expect(await Promise.all([probe.ready(), probe.ready(), probe.ready()])).toEqual([true, true, true]);
    expect(await probe.ready()).toBe(true); expect(check).toHaveBeenCalledTimes(1);
  });
  it("bounds a dependency that ignores abort without starting a second hidden probe", async () => {
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const probe = new ReadinessProbe(check, 5, 0);
    expect(await probe.ready()).toBe(false);
    expect(await probe.ready()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    release(); await delay(1);
  });
  it("never exposes configuration, credentials or arbitrary release fields", () => {
    const result = runtimeBuild({ revision: "postgres://credentials.invalid", builtAt: "not-a-date", password: "secret" });
    expect(result.revision).toBeNull(); expect(result.builtAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.expectedSchema).toBe("cloud-v1");
  });
  it("counts a resolved failed tool result without altering it", async () => {
    const measures = new RunMeasurements();
    const result = { ok: false, code: "TOOL_DENIED", message: "private tool error" };
    expect(await measures.measure("run", "tool_inclusive", async () => result, (value) => value.ok)).toBe(result);
    expect(measures.snapshot("run").stages?.tool_inclusive?.failures).toBe(1);
    expect(JSON.stringify(measures.snapshot("run"))).not.toContain("private tool error");
    expect(await measures.measure("run", "tool_inclusive", async () => result, () => { throw new Error("classifier"); })).toBe(result);
  });
  it("records numeric failures without swallowing or saving raw exception data", async () => {
    const measures = new RunMeasurements();
    await expect(measures.measure("run", "model_inclusive", async () => { throw new Error("private credential"); })).rejects.toThrow();
    const result = measures.snapshot("run");
    expect(result.stages?.model_inclusive?.failures).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private credential");
    expect(measures.snapshot("never-seen").stages).toBeNull();
  });
});
