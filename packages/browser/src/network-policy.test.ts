import { describe, expect, it } from "vitest";
import { PublicNetworkPolicy, isPublicNetworkAddress } from "./network-policy.js";

describe("PublicNetworkPolicy", () => {
  it("classifies private, loopback, documentation, multicast, and public addresses", () => {
    expect(isPublicNetworkAddress("127.0.0.1")).toBe(false);
    expect(isPublicNetworkAddress("10.1.2.3")).toBe(false);
    expect(isPublicNetworkAddress("192.168.1.5")).toBe(false);
    expect(isPublicNetworkAddress("203.0.113.10")).toBe(false);
    expect(isPublicNetworkAddress("::1")).toBe(false);
    expect(isPublicNetworkAddress("fd00::1")).toBe(false);
    expect(isPublicNetworkAddress("fec0::1")).toBe(false);
    expect(isPublicNetworkAddress("::127.0.0.1")).toBe(false);
    expect(isPublicNetworkAddress("2001:db8::1")).toBe(false);
    expect(isPublicNetworkAddress("8.8.8.8")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("accepts a standard public HTTPS target and returns the validated address", async () => {
    const policy = new PublicNetworkPolicy({
      resolver: async (hostname) => hostname === "public.example" ? [{ address: "8.8.8.8", family: 4 }] : [],
      cacheTtlMs: 0,
    });

    await expect(policy.validateNavigationUrl("https://public.example/path?q=1")).resolves.toMatchObject({
      address: "8.8.8.8",
      url: expect.objectContaining({ hostname: "public.example", pathname: "/path" }),
    });
  });

  it("rejects local names, credentials, non-standard ports and mixed public/private DNS answers", async () => {
    const policy = new PublicNetworkPolicy({
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      cacheTtlMs: 0,
    });

    await expect(policy.validateNavigationUrl("http://localhost/")).rejects.toMatchObject({ code: "BROWSER_URL_DENIED" });
    await expect(policy.validateNavigationUrl("https://user:pass@public.example/")).rejects.toMatchObject({ code: "BROWSER_URL_DENIED" });
    await expect(policy.validateNavigationUrl("https://public.example:8443/")).rejects.toMatchObject({ code: "BROWSER_URL_DENIED" });
    await expect(policy.validateNavigationUrl("https://public.example/")).rejects.toMatchObject({ code: "BROWSER_URL_DENIED" });
  });

  it("pins CONNECT validation to a public resolved address and port 443", async () => {
    const policy = new PublicNetworkPolicy({
      resolver: async () => [{ address: "1.1.1.1", family: 4 }],
      cacheTtlMs: 0,
    });

    await expect(policy.validateConnectAuthority("example.com:443")).resolves.toEqual({
      hostname: "example.com",
      address: "1.1.1.1",
      port: 443,
    });
    await expect(policy.validateConnectAuthority("example.com:444")).rejects.toMatchObject({ code: "BROWSER_PROXY_DENIED" });
  });
});
