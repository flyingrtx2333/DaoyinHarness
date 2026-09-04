import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PublicNetworkPolicyOptions {
  resolver?: HostResolver;
  cacheTtlMs?: number;
}

export interface PublicTarget {
  url: URL;
  address: string;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function ipv4InRange(address: string, network: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function publicIpv4(address: string): boolean {
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) => ipv4InRange(address, network, prefix));
}

function publicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  const dottedTail = normalized.slice(normalized.lastIndexOf(":") + 1);
  if (dottedTail.includes(".") && isIP(dottedTail) === 4) return publicIpv4(dottedTail);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/u.test(normalized) || /^fe[c-f]/u.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:") || normalized.startsWith("64:ff9b:")) return false;
  return true;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function blockedHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

function browserNetworkError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class PublicNetworkPolicy {
  readonly #resolver: HostResolver;
  readonly #cacheTtlMs: number;
  readonly #cache = new Map<string, { expiresAt: number; address: string }>();

  public constructor(options: PublicNetworkPolicyOptions = {}) {
    this.#resolver = options.resolver ?? (async (hostname) => lookup(hostname, { all: true, verbatim: true }));
    this.#cacheTtlMs = Math.max(0, Math.min(300_000, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
  }

  public async resolvePublicHost(hostname: string): Promise<string> {
    const normalized = hostname.replace(/^\[|\]$/gu, "").trim().toLowerCase();
    if (normalized.length === 0 || blockedHostname(normalized)) {
      throw browserNetworkError("BROWSER_URL_DENIED", "Local and private browser hosts are not allowed.");
    }
    if (isIP(normalized) !== 0) {
      if (!isPublicNetworkAddress(normalized)) {
        throw browserNetworkError("BROWSER_URL_DENIED", "Private or non-public browser IP addresses are not allowed.");
      }
      return normalized;
    }

    const cached = this.#cache.get(normalized);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.address;

    let addresses: ResolvedAddress[];
    try {
      addresses = await this.#resolver(normalized);
    } catch (error) {
      throw Object.assign(browserNetworkError("BROWSER_DNS_FAILED", "The browser hostname could not be resolved."), { cause: error });
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicNetworkAddress(entry.address))) {
      throw browserNetworkError("BROWSER_URL_DENIED", "The browser hostname resolves to a private or non-public address.");
    }
    const address = addresses[0]?.address;
    if (address === undefined) throw browserNetworkError("BROWSER_DNS_FAILED", "The browser hostname did not resolve to an address.");
    if (this.#cacheTtlMs > 0) this.#cache.set(normalized, { expiresAt: Date.now() + this.#cacheTtlMs, address });
    return address;
  }

  public async validateNavigationUrl(rawUrl: string): Promise<PublicTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw browserNetworkError("BROWSER_URL_INVALID", "Browser URL is invalid.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw browserNetworkError("BROWSER_URL_DENIED", "Only public HTTP(S) browser URLs are allowed.");
    }
    if (url.username || url.password) {
      throw browserNetworkError("BROWSER_URL_DENIED", "Browser URLs containing credentials are not allowed.");
    }
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const expected = url.protocol === "https:" ? "443" : "80";
    if (port !== expected) {
      throw browserNetworkError("BROWSER_URL_DENIED", "Browser navigation is limited to standard HTTP(S) ports.");
    }
    const address = await this.resolvePublicHost(normalizedHostname(url));
    return { url, address };
  }

  public async validateProxyHttpUrl(rawUrl: string): Promise<PublicTarget> {
    const target = await this.validateNavigationUrl(rawUrl);
    if (target.url.protocol !== "http:") {
      throw browserNetworkError("BROWSER_PROXY_DENIED", "Plain proxy requests must use HTTP; HTTPS uses CONNECT.");
    }
    return target;
  }

  public async validateConnectAuthority(authority: string): Promise<{ hostname: string; address: string; port: 443 }> {
    let url: URL;
    try {
      url = new URL(`https://${authority}`);
    } catch {
      throw browserNetworkError("BROWSER_PROXY_DENIED", "Browser CONNECT authority is invalid.");
    }
    if (url.username || url.password || (url.port && url.port !== "443")) {
      throw browserNetworkError("BROWSER_PROXY_DENIED", "Browser CONNECT is limited to public HTTPS port 443.");
    }
    const hostname = normalizedHostname(url);
    const address = await this.resolvePublicHost(hostname);
    return { hostname, address, port: 443 };
  }
}
