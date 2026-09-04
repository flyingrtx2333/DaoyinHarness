import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { PublicNetworkPolicy } from "./network-policy.js";

const CONNECT_TIMEOUT_MS = 15_000;

export interface PublicBrowserProxyOptions {
  policy?: PublicNetworkPolicy;
}

function statusMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Browser proxy denied the request.";
  return message.slice(0, 500);
}

function sanitizeProxyHeaders(headers: IncomingMessage["headers"], host: string): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "proxy-authorization" || normalized === "proxy-connection" || normalized === "connection") continue;
    result[name] = value;
  }
  result.host = host;
  result.connection = "close";
  return result;
}

export class PublicBrowserProxy {
  readonly #policy: PublicNetworkPolicy;
  readonly #server: http.Server;
  readonly #sockets = new Set<Socket>();
  #url: string | null = null;

  public constructor(options: PublicBrowserProxyOptions = {}) {
    this.#policy = options.policy ?? new PublicNetworkPolicy();
    this.#server = http.createServer((request, response) => {
      void this.#handleHttp(request, response);
    });
    this.#server.on("connect", (request, clientSocket, head) => {
      void this.#handleConnect(request, clientSocket, head);
    });
    this.#server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }

  public get url(): string {
    if (this.#url === null) throw Object.assign(new Error("Browser proxy has not started."), { code: "BROWSER_PROXY_NOT_STARTED" });
    return this.#url;
  }

  public async start(): Promise<string> {
    if (this.#url !== null) return this.#url;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw Object.assign(new Error("Browser proxy did not receive a loopback TCP address."), { code: "BROWSER_PROXY_START_FAILED" });
    }
    this.#url = `http://127.0.0.1:${String(address.port)}`;
    return this.#url;
  }

  public async close(): Promise<void> {
    this.#url = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.url === undefined) throw Object.assign(new Error("Browser proxy request URL is missing."), { code: "BROWSER_PROXY_DENIED" });
      const target = await this.#policy.validateProxyHttpUrl(request.url);
      const upstream = http.request({
        host: target.address,
        port: 80,
        method: request.method ?? "GET",
        path: `${target.url.pathname}${target.url.search}`,
        headers: sanitizeProxyHeaders(request.headers, target.url.host),
        timeout: CONNECT_TIMEOUT_MS,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.once("timeout", () => upstream.destroy(new Error("Browser proxy upstream timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("Browser proxy upstream failed.");
      });
      request.pipe(upstream);
    } catch (error) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end(statusMessage(error));
    }
  }

  async #handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    try {
      if (request.url === undefined) throw Object.assign(new Error("Browser CONNECT target is missing."), { code: "BROWSER_PROXY_DENIED" });
      const target = await this.#policy.validateConnectAuthority(request.url);
      const upstream = net.connect({ host: target.address, port: target.port });
      this.#sockets.add(upstream);
      upstream.once("close", () => this.#sockets.delete(upstream));
      const timer = setTimeout(() => upstream.destroy(new Error("Browser CONNECT timed out.")), CONNECT_TIMEOUT_MS);
      upstream.once("connect", () => {
        clearTimeout(timer);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: DaoyinHarness\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.once("error", () => {
        clearTimeout(timer);
        if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
    } catch (error) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${statusMessage(error)}`);
    }
  }
}
