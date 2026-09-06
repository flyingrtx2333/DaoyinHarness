import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./repository.js";

type Stage = "model_inclusive" | "tool_inclusive" | "event_persist";
interface Measurement { count: number; failures: number; totalMs: number; maxMs: number }
const rounded = (n: number): number => Math.round(Math.max(0, n) * 100) / 100;

/** Bounded process-local numeric observations; no prompt, tool input, output or exception text. */
export class RunMeasurements {
  readonly #runs = new Map<string, { updatedAt: number; values: Partial<Record<Stage, Measurement>> }>();
  public async measure<T>(runId: string, stage: Stage, action: () => Promise<T>,
    succeeded: (result: T) => boolean = () => true): Promise<T> {
    const start = performance.now(); let ok = false;
    try {
      const result = await action();
      // A resolved ToolFailure is still a failure. Observability must not change
      // the returned business result, even if an optional classifier fails.
      try { ok = succeeded(result); } catch { ok = false; }
      return result;
    }
    finally {
      const duration = rounded(performance.now() - start);
      let entry = this.#runs.get(runId);
      if (!entry) {
        if (this.#runs.size >= 256) this.#runs.delete(this.#runs.keys().next().value!);
        entry = { updatedAt: Date.now(), values: {} }; this.#runs.set(runId, entry);
      }
      entry.updatedAt = Date.now();
      const value = entry.values[stage] ?? { count: 0, failures: 0, totalMs: 0, maxMs: 0 };
      value.count++; value.failures += ok ? 0 : 1; value.totalMs = rounded(value.totalMs + duration); value.maxMs = Math.max(value.maxMs, duration);
      entry.values[stage] = value;
    }
  }
  public snapshot(runId: string): { source: string; stages: Partial<Record<Stage, Measurement>> | null } {
    const entry = this.#runs.get(runId);
    if (!entry || Date.now() - entry.updatedAt > 30 * 60_000) {
      this.#runs.delete(runId);
      return { source: "unavailable_after_restart_or_expiry", stages: null };
    }
    return { source: "current_process_inclusive_durations", stages: structuredClone(entry.values) };
  }
}

/** Caller must verify the Run's full execution scope BEFORE reading its events. */
export function describeRun(run: CloudRun, history: readonly AgentEvent[], measurements: RunMeasurements) {
  // The history read may finish after a concurrent commit. Keep the persistent
  // diagnostic at the Run snapshot's cursor instead of mixing two points in time.
  const events = history.filter((event) => event.sessionId === run.sessionId && event.turnId === run.id && event.eventSeq <= run.lastEventSeq);
  const started = events.find((event) => event.type === "turn.started");
  const firstText = events.find((event) => event.type === "assistant.delta");
  const terminal = events.findLast((event) => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type));
  const time = (event?: AgentEvent): number | null => event && Number.isFinite(Date.parse(event.occurredAt)) ? Date.parse(event.occurredAt) : null;
  const elapsed = (from: number | null, to: number | null): number | null => from === null || to === null ? null : Math.max(0, to - from);
  const toolStarts = new Map<string, AgentEvent>();
  const tools: Array<{ name: string; status: string; durationMs: number | null }> = [];
  for (const event of events) {
    if (event.type === "tool.started") toolStarts.set(event.payload.toolCallId, event);
    else if (event.type === "tool.completed" || event.type === "tool.failed") {
      tools.push({ name: /^[A-Za-z0-9_.-]{1,100}$/u.test(event.payload.toolName) ? event.payload.toolName : "redacted",
        status: event.type === "tool.completed" ? "completed" : "failed",
        durationMs: elapsed(time(toolStarts.get(event.payload.toolCallId)), time(event)) });
      toolStarts.delete(event.payload.toolCallId);
    }
  }
  return { schemaVersion: 1, runId: run.id, status: run.status, lastEventSeq: run.lastEventSeq,
    source: "persisted_events", events: events.length,
    textEvents: events.filter((event) => event.type === "assistant.delta").length,
    firstPersistedTextMs: elapsed(time(started), time(firstText)),
    totalRecordedMs: elapsed(time(started), time(terminal)),
    unfinishedToolCalls: toolStarts.size, tools,
    runtime: measurements.snapshot(run.id),
    unavailable: ["provider_token_latency", "browser_render_latency", "usage_settlement"],
  };
}
