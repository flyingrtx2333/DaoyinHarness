import { readFile } from "node:fs/promises";

export interface RuntimeBuild {
  revision: string | null;
  builtAt: string | null;
  protocolVersion: 1;
  eventStreamVersion: 1;
  expectedSchema: "cloud-v1";
}
export function runtimeBuild(value: unknown): RuntimeBuild {
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    revision: typeof raw.revision === "string" && /^[a-f0-9]{40}$/u.test(raw.revision) ? raw.revision : null,
    builtAt: typeof raw.builtAt === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(raw.builtAt) && Number.isFinite(Date.parse(raw.builtAt)) ? raw.builtAt : null,
    protocolVersion: 1, eventStreamVersion: 1, expectedSchema: "cloud-v1",
  };
}
export async function loadRuntimeBuild(url: URL): Promise<RuntimeBuild> {
  try {
    const data = await readFile(url, "utf8");
    if (data.length > 4096) return runtimeBuild(null);
    return runtimeBuild(JSON.parse(data) as unknown);
  } catch { return runtimeBuild(null); }
}

/** Single flight even when a broken dependency ignores abort. No paid or mutating probes. */
export class ReadinessProbe {
  #pending: Promise<boolean> | undefined;
  #cached: { checkedAt: number; ready: boolean } | undefined;
  public constructor(private readonly check: ((signal: AbortSignal) => Promise<void>) | undefined,
    private readonly timeoutMs = 4000, private readonly cacheMs = 5000) {}

  public async ready(): Promise<boolean> {
    if (!this.check) return false;
    if (this.#cached && Date.now() - this.#cached.checkedAt < this.cacheMs) return this.#cached.ready;
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (!this.#pending) {
      this.#pending = Promise.resolve().then(() => this.check!(signal)).then(() => !signal.aborted, () => false).then((ready) => {
        this.#cached = { checkedAt: Date.now(), ready };
        return ready;
      }).finally(() => { this.#pending = undefined; });
    }
    let listener: (() => void) | undefined;
    const expired = new Promise<boolean>((resolve) => {
      listener = () => resolve(false);
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    });
    try { return await Promise.race([this.#pending, expired]); }
    finally { if (listener) signal.removeEventListener("abort", listener); }
  }
}
