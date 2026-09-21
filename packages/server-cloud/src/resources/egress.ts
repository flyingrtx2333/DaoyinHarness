import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net, { isIP } from "node:net";
import { Pool } from "pg";

const secret = process.env.HARNESS_EGRESS_HMAC_SECRET ?? "";
const databaseUrl = process.env.HARNESS_RESOURCES_DATABASE_URL ?? "";
const port = Number(process.env.HARNESS_EGRESS_PORT ?? 3128);
const deniedNames = (process.env.HARNESS_EGRESS_DENIED_HOSTS ?? "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
if (secret.length < 32 || !databaseUrl || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Egress proxy configuration is invalid.");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

interface Grant { workspaceId: string; runId: string; expiresAt: number }
function grant(request: http.IncomingMessage): Grant {
  const authorization = request.headers["proxy-authorization"] ?? "";
  const matched = /^Basic\s+(.+)$/iu.exec(Array.isArray(authorization) ? authorization[0] ?? "" : authorization);
  if (!matched) throw new Error("missing proxy authorization");
  const [payload = "", signature = ""] = Buffer.from(matched[1]!, "base64").toString("utf8").split(":", 2);
  const actual = Buffer.from(signature); const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid proxy authorization");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Grant;
  if (!/^wsp_[a-f0-9]{24}$/u.test(value.workspaceId) || !value.runId || value.runId.length > 160 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("expired proxy authorization");
  return value;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const bytes = address.split(".").map(Number); const [a = 0, b = 0] = bytes;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) ||
      a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return publicAddress(lower.slice(7));
    return lower !== "::" && lower !== "::1" && !/^(?:fc|fd|fe[89ab]|ff)/u.test(lower);
  }
  return false;
}

async function destination(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host === "localhost" || deniedNames.some((name) => host === name || host.endsWith(`.${name}`))) throw new Error("destination name is denied");
  const values = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await lookup(host, { all: true, verbatim: true });
  if (!values.length || values.some((item) => !publicAddress(item.address))) throw new Error("destination address is denied");
  const selected = values[0]!;
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

async function audit(value: Grant | undefined, hostname: string, targetPort: number, method: string | null,
  sent: number, received: number, decision: "allowed" | "denied", reason?: string): Promise<void> {
  if (!value) return;
  await pool.query(`INSERT INTO harness_network_audit(owner_key,workspace_id,run_id,hostname,port,method,bytes_sent,bytes_received,decision,reason)
    SELECT r.owner_key,$1,$2,$3,$4,$5,$6,$7,$8,$9 FROM harness_resources r WHERE r.id=$1`,
    [value.workspaceId, value.runId, hostname.slice(0, 253), targetPort, method, sent, received, decision, reason?.slice(0, 300) ?? null]).catch(() => undefined);
}

const server = http.createServer((request, response) => { void (async () => {
  let value: Grant | undefined; let hostname = "invalid"; let targetPort = 80; let sent = 0; let received = 0;
  try {
    value = grant(request); const target = new URL(request.url ?? "");
    if (target.protocol !== "http:") throw new Error("only absolute HTTP proxy requests are accepted");
    hostname = target.hostname; targetPort = Number(target.port || 80); const resolved = await destination(hostname);
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const upstream = http.request({ protocol: "http:", hostname, port: targetPort, method: request.method, path: `${target.pathname}${target.search}`,
      headers, lookup: (_host, _options, callback) => callback(null, resolved.address, resolved.family) }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.on("data", (chunk: Buffer) => { received += chunk.byteLength; }); reply.pipe(response);
      reply.once("end", () => { void audit(value, hostname, targetPort, request.method ?? null, sent, received, "allowed"); });
    });
    upstream.once("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(); void audit(value, hostname, targetPort, request.method ?? null, sent, received, "denied", error.message); });
    request.on("data", (chunk: Buffer) => { sent += chunk.byteLength; }); request.pipe(upstream);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "egress denied"; response.writeHead(403).end("Egress destination denied.\n");
    await audit(value, hostname, targetPort, request.method ?? null, sent, received, "denied", reason);
  }
})(); });

server.on("connect", (request, client, head) => { void (async () => {
  let value: Grant | undefined; let hostname = "invalid"; let targetPort = 443; let sent = head.byteLength; let received = 0;
  try {
    value = grant(request); const separator = (request.url ?? "").lastIndexOf(":");
    if (separator < 1) throw new Error("CONNECT destination is invalid");
    hostname = request.url!.slice(0, separator).replace(/^\[|\]$/gu, ""); targetPort = Number(request.url!.slice(separator + 1));
    if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("CONNECT port is invalid");
    const resolved = await destination(hostname); const upstream = net.connect({ host: resolved.address, port: targetPort, family: resolved.family });
    upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    client.on("data", (chunk: Buffer) => { sent += chunk.byteLength; }); upstream.on("data", (chunk: Buffer) => { received += chunk.byteLength; });
    const completed = (): void => { void audit(value, hostname, targetPort, "CONNECT", sent, received, "allowed"); };
    upstream.once("close", completed); upstream.once("error", (error) => { client.destroy(); void audit(value, hostname, targetPort, "CONNECT", sent, received, "denied", error.message); });
  } catch (error) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    await audit(value, hostname, targetPort, "CONNECT", sent, received, "denied", error instanceof Error ? error.message : "egress denied");
  }
})(); });

server.listen(port, "0.0.0.0");
async function close(): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); await pool.end(); }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
