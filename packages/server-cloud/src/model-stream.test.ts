import { expect, it } from "vitest";
import { readModelStream } from "./model-stream.js";

it("delivers UTF-8 chunks before completion and waits for the durable result", async () => {
  const encoder = new TextEncoder();
  let pipe!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { pipe = controller; } });
  const chunks: string[] = [];
  let first!: () => void;
  const received = new Promise<void>(resolve => { first = resolve; });
  const result = readModelStream(new Response(stream), async delta => { chunks.push(delta); first(); }, new AbortController().signal);
  const bytes = encoder.encode('{"type":"text","delta":"你好"}\n');
  pipe.enqueue(bytes.slice(0, 26)); pipe.enqueue(bytes.slice(26));
  await received;
  expect(chunks).toEqual(["你好"]);
  pipe.enqueue(encoder.encode('{"type":"result","value":{"output":"你好"}}\n')); pipe.close();
  await expect(result).resolves.toEqual({ output: "你好" });
});

it("rejects truncated, failed and oversized streams instead of inventing completion", async () => {
  for (const body of ['{"type":"text","delta":"partial"}\n', '{"type":"error","code":"PRIVATE"}\n', '{"type":"result","value":{}}', JSON.stringify({ type: "text", delta: "x".repeat(16001) }) + "\n"]) {
    await expect(readModelStream(new Response(body), async () => undefined, new AbortController().signal)).rejects.toThrow();
  }
});
