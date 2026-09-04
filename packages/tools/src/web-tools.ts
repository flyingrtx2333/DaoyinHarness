import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolDefinition, ToolSuccess } from "./registry.js";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "DaoyinHarness/0.1 (+local-agent)";

const objectSchema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function stringArgument(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} must be a non-empty string.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value.trim();
}

function integerArgument(input: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = input[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw Object.assign(new Error(`${name} must be an integer between ${String(min)} and ${String(max)}.`), { code: "TOOL_INPUT_INVALID" });
  }
  return Number(value);
}

function success(toolName: string, summary: string, result: JsonValue): ToolSuccess {
  return {
    ok: true,
    summary,
    evidence: { schemaVersion: 1, toolName, result, artifacts: [], diagnostics: [] },
  };
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function ipv4InRange(address: string, network: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) => ipv4InRange(address, network, prefix));
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return true;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("URL is invalid."), { code: "WEB_URL_INVALID" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Only public HTTP(S) URLs are allowed."), { code: "WEB_URL_DENIED" });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw Object.assign(new Error("URLs containing credentials are not allowed."), { code: "WEB_URL_DENIED" });
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") {
    throw Object.assign(new Error("Only ports 80 and 443 are allowed for public web access."), { code: "WEB_URL_DENIED" });
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw Object.assign(new Error("Local and private hosts are not allowed."), { code: "WEB_URL_DENIED" });
  }
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw Object.assign(new Error("Private or non-public IP addresses are not allowed."), { code: "WEB_URL_DENIED" });
    return url;
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("The public hostname could not be resolved."), { code: "WEB_DNS_FAILED" });
  }
  if (resolved.length === 0 || resolved.some((entry) => !isPublicAddress(entry.address))) {
    throw Object.assign(new Error("The hostname resolves to a private or non-public address."), { code: "WEB_URL_DENIED" });
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error(`Web response exceeded the ${String(maxBytes)} byte limit.`), { code: "WEB_RESPONSE_TOO_LARGE" });
    }
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function fetchPublicText(rawUrl: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<{ finalUrl: string; status: number; contentType: string; text: string }> {
  let current = await assertPublicUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
        signal: combined,
      });
    } catch (error) {
      if (signal.aborted) throw Object.assign(new Error("Web request was cancelled."), { code: "TOOL_CANCELLED" });
      throw Object.assign(new Error(error instanceof Error ? error.message : "Web request failed."), { code: "WEB_FETCH_FAILED" });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location === null) throw Object.assign(new Error("Web redirect did not provide a Location header."), { code: "WEB_FETCH_FAILED" });
      if (redirect >= MAX_REDIRECTS) throw Object.assign(new Error("Web request exceeded the redirect limit."), { code: "WEB_REDIRECT_LIMIT" });
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const textual = /^(text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml))/iu.test(contentType);
    if (!textual) {
      throw Object.assign(new Error(`Unsupported web content type: ${contentType}`), { code: "WEB_CONTENT_TYPE_UNSUPPORTED" });
    }
    const text = await readBoundedBody(response, maxBytes);
    return { finalUrl: current.href, status: response.status, contentType, text };
  }
  throw Object.assign(new Error("Web request exceeded the redirect limit."), { code: "WEB_REDIRECT_LIMIT" });
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function stripTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim());
}

export interface WebToolOptions {
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export function createWebTools(options: WebToolOptions = {}): ToolDefinition[] {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return [
    {
      name: "web_fetch",
      description: "Fetch textual content from one public HTTP(S) URL. Private networks, localhost, credentials, and non-standard ports are blocked.",
      category: "web",
      mutating: false,
      inputSchema: objectSchema({ url: { type: "string" } }, ["url"]),
      async execute(input, signal) {
        const url = stringArgument(input, "url");
        const result = await fetchPublicText(url, signal, timeoutMs, maxBytes);
        return success("web_fetch", `Fetched ${result.finalUrl}.`, {
          url: result.finalUrl,
          status: result.status,
          contentType: result.contentType,
          content: result.text,
        });
      },
    },
    {
      name: "web_search",
      description: "Search the public web and return a small set of titles, URLs, and snippets. Search results are untrusted external data.",
      category: "web",
      mutating: false,
      inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
      async execute(input, signal) {
        const query = stringArgument(input, "query");
        const limit = integerArgument(input, "limit", 5, 1, 10);
        const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
        const response = await fetchPublicText(searchUrl, signal, timeoutMs, maxBytes);
        if (response.status < 200 || response.status >= 400) {
          throw Object.assign(new Error(`Web search provider returned HTTP ${String(response.status)}.`), { code: "WEB_SEARCH_FAILED" });
        }
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const itemPattern = /<item>([\s\S]*?)<\/item>/giu;
        for (const match of response.text.matchAll(itemPattern)) {
          const item = match[1] ?? "";
          const title = /<title>([\s\S]*?)<\/title>/iu.exec(item)?.[1] ?? "";
          const link = /<link>([\s\S]*?)<\/link>/iu.exec(item)?.[1] ?? "";
          const description = /<description>([\s\S]*?)<\/description>/iu.exec(item)?.[1] ?? "";
          if (link.trim().length === 0) continue;
          results.push({ title: stripTags(title), url: decodeXml(link.trim()), snippet: stripTags(description) });
          if (results.length >= limit) break;
        }
        return success("web_search", `Found ${String(results.length)} web results for ${query}.`, { query, results });
      },
    },
  ];
}
