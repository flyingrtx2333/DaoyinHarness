import { isAbsolute, resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadRuntimeBuild } from "../runtime-health.js";
import { createEvaluationService } from "./service.js";
import { EvaluationStore } from "./store.js";
import { PlatformEvaluationRuntime } from "./live-runner.js";
import { record } from "./contracts.js";

// This entry is never imported by the production Agent server. Use a separate OS user/env.
const database = process.env.DAOYIN_EVAL_DB ?? "";
const serviceToken = process.env.DAOYIN_EVAL_SERVICE_TOKEN ?? "";
const platform = new URL(process.env.DAOYIN_EVAL_PLATFORM_URL ?? "invalid:");
const port = Number(process.env.DAOYIN_EVAL_PORT ?? 4711);
if (!isAbsolute(database) || resolve(database) === resolve(process.env.DAOYIN_CLOUD_DATABASE ?? "public.sqlite") ||
    process.env.DAOYIN_CLOUD_POSTGRES_URL || !/^[\x21-\x7e]{32,256}$/u.test(serviceToken) ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || platform.username || platform.password || platform.search || platform.hash || platform.pathname !== "/" ||
    !(platform.protocol === "https:" || platform.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(platform.hostname))) {
  throw new Error("Configure a separate evaluation database, service identity, platform origin and port; do not reuse the production runtime environment.");
}
const runtime = new PlatformEvaluationRuntime(platform, serviceToken);
const build = await loadRuntimeBuild(new URL("./release.json", import.meta.url));
await mkdir(dirname(database), { recursive: true, mode: 0o700 });
const store = new EvaluationStore(database);
const app = createEvaluationService({ store, serviceToken, revision: build.revision,
  runtime,
  authorize: async (authority, parent) => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
    try {
      const response = await fetch(new URL("/api/internal/harness-evaluation/authorize", platform), { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", "x-eval-service-token": serviceToken }, body: JSON.stringify(authority) });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const reader = response.body?.getReader(); if (!reader) return false;
      let text = ""; const decoder = new TextDecoder();
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; if (chunk.value.byteLength + Buffer.byteLength(text) > 4096) return false; text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const result: unknown = JSON.parse(text);
      return record(result) && result.active === true;
    } catch { return false; }
  },
});
let closing: Promise<void> | undefined;
function close(): Promise<void> { return closing ??= app.close().finally(() => store.close()); }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
try { await app.listen({ host: "127.0.0.1", port }); process.stdout.write(`Isolated evaluation service listening on 127.0.0.1:${port}\n`); }
catch { await close(); throw new Error("Evaluation service could not start."); }
