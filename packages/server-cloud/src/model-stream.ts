/** Bounded internal NDJSON transport. A final validated reply is mandatory. */
export async function readModelStream(response: Response, onTextDelta: (delta: string) => Promise<void>, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing model stream.");
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = ""; let bytes = 0; let text = ""; let result: unknown; let finished = false;
  async function line(value: string): Promise<void> {
    if (!value.trim()) return;
    signal.throwIfAborted();
    if (finished) throw new Error("Data after model completion.");
    const item: unknown = JSON.parse(value);
    if (typeof item !== "object" || item === null || !("type" in item)) throw new Error("Invalid model frame.");
    if (item.type === "text" && "delta" in item && typeof item.delta === "string") {
      text += item.delta;
      if (text.length > 16_000) throw new Error("Model text exceeds limit.");
      await onTextDelta(item.delta);
    } else if (item.type === "result" && "value" in item) { result = item.value; finished = true; }
    else throw new Error("Model stream failed.");
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 512_000) throw new Error("Model stream exceeds limit.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { const value = buffer.slice(0, end); buffer = buffer.slice(end + 1); await line(value); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error("Incomplete model frame.");
    if (!finished) throw new Error("Model stream ended before completion.");
    return result;
  } finally { signal.removeEventListener("abort", abort); await reader.cancel(); reader.releaseLock(); }
}
