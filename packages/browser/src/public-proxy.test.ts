import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PublicNetworkPolicy } from "./network-policy.js";
import { PublicBrowserProxy } from "./public-proxy.js";

const proxies: PublicBrowserProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(async (proxy) => proxy.close()));
});

async function responseText(proxyUrl: string, targetUrl: string): Promise<{ status: number; text: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: proxy.hostname,
      port: Number(proxy.port),
      path: targetUrl,
      headers: { host: new URL(targetUrl).host },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.once("error", reject);
  });
}

describe("PublicBrowserProxy", () => {
  it("binds to loopback and rejects HTTP hosts that resolve privately", async () => {
    const proxy = new PublicBrowserProxy({
      policy: new PublicNetworkPolicy({
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
        cacheTtlMs: 0,
      }),
    });
    proxies.push(proxy);
    const url = await proxy.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    await expect(responseText(url, "http://private.example/")).resolves.toMatchObject({
      status: 403,
      text: expect.stringContaining("private or non-public"),
    });
  });

  it("rejects CONNECT targets that resolve privately before opening an upstream socket", async () => {
    const proxy = new PublicBrowserProxy({
      policy: new PublicNetworkPolicy({
        resolver: async () => [{ address: "10.0.0.5", family: 4 }],
        cacheTtlMs: 0,
      }),
    });
    proxies.push(proxy);
    const url = new URL(await proxy.start());

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: url.hostname, port: Number(url.port) });
      let text = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write("CONNECT private.example:443 HTTP/1.1\r\nHost: private.example:443\r\n\r\n"));
      socket.on("data", (chunk: string) => { text += chunk; });
      socket.once("end", () => resolve(text));
      socket.once("error", reject);
    });

    expect(response).toContain("403 Forbidden");
    expect(response).toContain("private or non-public");
  });
});
