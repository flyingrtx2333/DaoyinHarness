import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CloudCredentialProvider } from "./gateway-model-client.js";
import { ModelGatewayError } from "./gateway-model-client.js";

const CLIENT_ID = "daoyin-harness";
const SCOPE = "harness:ai";
const MAX_OAUTH_RESPONSE_BYTES = 65_536;
const OAUTH_TIMEOUT_MS = 30_000;

export interface DaoyinAccountSummary { id: number; userName: string; tenantId: number }
export type DaoyinAuthenticationStatus =
  | { status: "signed_out"; account: null }
  | { status: "authorizing"; account: null }
  | { status: "signed_in"; account: DaoyinAccountSummary };
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  account: DaoyinAccountSummary;
}
export interface OAuthCredentialStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}
export class InMemoryOAuthCredentialStore implements OAuthCredentialStore {
  #tokens: StoredTokens | null = null;
  public async load(): Promise<StoredTokens | null> { return this.#tokens === null ? null : structuredClone(this.#tokens); }
  public async save(tokens: StoredTokens): Promise<void> { this.#tokens = structuredClone(tokens); }
  public async clear(): Promise<void> { this.#tokens = null; }
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const fail = (): void => {
      failed = true;
      child.kill();
      reject(new Error("Windows 凭据保护失败，请检查当前 Windows 用户的凭据存储权限。"));
    };
    const timer = setTimeout(fail, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 262_144) fail();
      else output.push(chunk);
    });
    // Never surface PowerShell stderr: conversion errors can echo credential input.
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.once("error", () => { clearTimeout(timer); fail(); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code === 0) resolve(Buffer.concat(output).toString("utf8").trim());
      else fail();
    });
    child.stdin.end(input, "utf8");
  });
}

function validAccount(value: unknown): value is DaoyinAccountSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const account = value as Partial<DaoyinAccountSummary>;
  return Number.isSafeInteger(account.id) && Number(account.id) > 0
    && Number.isSafeInteger(account.tenantId) && Number(account.tenantId) >= 0
    && typeof account.userName === "string" && account.userName.length > 0 && account.userName.length <= 256;
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\r\n]/u.test(value);
}
function validStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tokens = value as Partial<StoredTokens>;
  return validToken(tokens.accessToken) && validToken(tokens.refreshToken)
    && typeof tokens.accessExpiresAt === "number" && Number.isFinite(tokens.accessExpiresAt)
    && validAccount(tokens.account);
}

export class WindowsDpapiCredentialStore implements OAuthCredentialStore {
  readonly #filePath: string;
  public constructor(dataDir: string) { this.#filePath = path.join(dataDir, "credentials", "daoyin-oauth.dpapi"); }
  public async load(): Promise<StoredTokens | null> {
    if (process.platform !== "win32") return null;
    let encrypted: string;
    try { encrypted = await readFile(this.#filePath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const script = "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1';$raw=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString $raw;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}";
    const plain = await runPowerShell(script, encrypted.trim());
    const parsed: unknown = JSON.parse(plain);
    return validStoredTokens(parsed) ? parsed : null;
  }
  public async save(tokens: StoredTokens): Promise<void> {
    if (process.platform !== "win32") throw new Error("Daoyin Harness account storage is supported on Windows only.");
    const script = "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1';$raw=[Console]::In.ReadToEnd();$secure=ConvertTo-SecureString $raw -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString $secure))";
    const encrypted = await runPowerShell(script, JSON.stringify(tokens));
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, encrypted, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally { await rm(temporary, { force: true }); }
  }
  public async clear(): Promise<void> { await rm(this.#filePath, { force: true }); }
}

interface PendingAuthorization { verifier: string; redirectUri: string; expiresAt: number; generation: number }
export interface DaoyinOAuthSessionOptions {
  platformUrl: string;
  port: number;
  credentialStore: OAuthCredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
}
function platformBase(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("道引平台地址必须使用 HTTPS；仅本机开发服务可使用 HTTP。");
  }
  url.pathname = url.pathname.replace(/\/$/u, ""); url.search = ""; url.hash = "";
  return url;
}
function challenge(verifier: string): string { return createHash("sha256").update(verifier, "ascii").digest("base64url"); }
function parseTokenResponse(payload: unknown, now: number): StoredTokens {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ModelGatewayError("MODEL_AUTH_RESPONSE_INVALID", "道引授权返回格式无效，现有登录信息未被删除。");
  const value = payload as Record<string, unknown>;
  const user = typeof value.user === "object" && value.user !== null ? value.user as Record<string, unknown> : {};
  const account = { id: user.id, userName: user.user_name, tenantId: user.tenant_id };
  if (!validToken(value.access_token) || !validToken(value.refresh_token) || !validAccount(account)
    || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0
    || !Number.isFinite(now + value.expires_in * 1_000)
    || (value.token_type !== undefined && (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))) {
    throw new ModelGatewayError("MODEL_AUTH_RESPONSE_INVALID", "道引授权返回的令牌或账号信息无效。");
  }
  return { accessToken: value.access_token, refreshToken: value.refresh_token, accessExpiresAt: now + value.expires_in * 1_000, account };
}
async function readOAuthPayload(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) throw new ModelGatewayError("MODEL_AUTH_RESPONSE_INVALID", "道引授权响应超过安全长度限制。");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { return null; }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function oauthErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" ? error : null;
}
function waitForCredential(promise: Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new DOMException("The model request was aborted.", "AbortError"));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    // A cancelled caller must not cancel the shared refresh or discard a rotated token.
    void promise.then((value) => { if (signal.aborted) aborted(); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class DaoyinOAuthSession implements CloudCredentialProvider {
  readonly #platform: URL;
  readonly #port: number;
  readonly #store: OAuthCredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingAuthorization>();
  #tokens: StoredTokens | null = null;
  #refreshing: Promise<string> | null = null;
  #generation = 0;
  #storeWrites: Promise<void> = Promise.resolve();
  public constructor(options: DaoyinOAuthSessionOptions) {
    this.#platform = platformBase(options.platformUrl); this.#port = options.port;
    this.#store = options.credentialStore; this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? Date.now;
  }
  public get authority(): string { return this.#platform.origin; }
  public get gatewayEndpoint(): string { return new URL("/api/harness/ai/responses", this.#platform).toString(); }
  public async initialize(): Promise<void> {
    try { const stored = await this.#store.load(); this.#tokens = validStoredTokens(stored) ? stored : null; }
    catch { this.#tokens = null; }
  }
  public status(): DaoyinAuthenticationStatus {
    if (this.#tokens !== null) return { status: "signed_in", account: { ...this.#tokens.account } };
    for (const [key, pending] of this.#pending) { if (pending.expiresAt <= this.#now()) this.#pending.delete(key); }
    return { status: this.#pending.size > 0 ? "authorizing" : "signed_out", account: null };
  }
  #assertGeneration(generation: number): void {
    if (generation !== this.#generation) throw new ModelGatewayError("MODEL_AUTH_CHANGED", "登录状态已经改变，请重试当前操作。");
  }
  #writeStore(action: () => Promise<void>): Promise<void> {
    const write = this.#storeWrites.then(action);
    this.#storeWrites = write.catch(() => undefined);
    return write;
  }
  async #save(tokens: StoredTokens, generation: number): Promise<void> {
    await this.#writeStore(async () => {
      this.#assertGeneration(generation);
      try { await this.#store.save(tokens); }
      catch { throw new ModelGatewayError("MODEL_AUTH_STORAGE_FAILED", "无法安全保存登录信息，请检查操作系统凭据存储。"); }
      this.#assertGeneration(generation);
      this.#tokens = tokens;
    });
  }
  public beginAuthorization(): { authorizationUrl: string } {
    this.#pending.clear();
    const generation = ++this.#generation;
    this.#refreshing = null;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const redirectUri = `http://127.0.0.1:${String(this.#port)}/api/v1/auth/callback`;
    this.#pending.set(state, { verifier, redirectUri, expiresAt: this.#now() + 5 * 60_000, generation });
    const url = new URL("/api/oauth/authorize", this.#platform);
    url.searchParams.set("client_id", CLIENT_ID); url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri); url.searchParams.set("code_challenge", challenge(verifier));
    url.searchParams.set("code_challenge_method", "S256"); url.searchParams.set("state", state); url.searchParams.set("scope", SCOPE);
    return { authorizationUrl: url.toString() };
  }
  async #requestTokens(form: URLSearchParams): Promise<unknown> {
    const signal = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
    try {
      const response = await this.#fetch(new URL("/api/oauth/token", this.#platform), {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form,
      });
      // Check transient statuses before parsing: reverse proxies often return HTML.
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelGatewayError(response.status === 429 ? "MODEL_AUTH_RATE_LIMITED" : "MODEL_AUTH_UNAVAILABLE",
          "道引授权服务暂时不可用，登录信息已保留，请稍后重试。", { status: response.status, retryable: true });
      }
      const payload = await readOAuthPayload(response);
      if (!response.ok) {
        const invalidGrant = [400, 401, 403].includes(response.status) && oauthErrorCode(payload) === "invalid_grant";
        throw new ModelGatewayError(invalidGrant ? "MODEL_AUTH_REQUIRED" : "MODEL_AUTH_REJECTED",
          invalidGrant ? "道引授权已失效，请重新登录。" : "道引授权请求被拒绝，请检查账号授权或客户端配置。", { status: response.status });
      }
      return payload;
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError(signal.aborted ? "MODEL_AUTH_TIMEOUT" : "MODEL_AUTH_NETWORK",
        "暂时无法连接道引授权服务，登录信息已保留。", { retryable: true });
    }
  }
  public async completeAuthorization(code: string, state: string): Promise<DaoyinAccountSummary> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.expiresAt <= this.#now()) throw new Error("登录回调已过期，请重新发起登录。");
    this.#assertGeneration(pending.generation);
    const payload = await this.#requestTokens(new URLSearchParams({
      grant_type: "authorization_code", client_id: CLIENT_ID, code,
      redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    }));
    this.#assertGeneration(pending.generation);
    const tokens = parseTokenResponse(payload, this.#now());
    await this.#save(tokens, pending.generation);
    return { ...tokens.account };
  }
  async #refresh(current: StoredTokens, generation: number): Promise<string> {
    let payload: unknown;
    try {
      payload = await this.#requestTokens(new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refreshToken }));
    } catch (error) {
      this.#assertGeneration(generation);
      // Only a confirmed invalid_grant revokes local login. 429/5xx/network,
      // malformed responses and invalid_client must never destroy the credential.
      if (error instanceof ModelGatewayError && error.code === "MODEL_AUTH_REQUIRED") {
        this.#tokens = null;
        ++this.#generation;
        await this.#writeStore(() => this.#store.clear());
      }
      throw error;
    }
    this.#assertGeneration(generation);
    const tokens = parseTokenResponse(payload, this.#now());
    if (tokens.account.id !== current.account.id || tokens.account.tenantId !== current.account.tenantId) {
      throw new ModelGatewayError("MODEL_AUTH_IDENTITY_MISMATCH", "刷新返回的账号与当前账号不一致，已拒绝使用该凭据。");
    }
    await this.#save(tokens, generation);
    return tokens.accessToken;
  }
  public async getCredential(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException("The model request was aborted.", "AbortError");
    if (this.#tokens === null) throw new ModelGatewayError("MODEL_AUTH_REQUIRED", "请先登录道引科技账号。");
    if (this.#tokens.accessExpiresAt > this.#now() + 60_000) return this.#tokens.accessToken;
    if (this.#refreshing === null) {
      const refresh = this.#refresh(this.#tokens, this.#generation);
      const shared: Promise<string> = refresh.finally(() => { if (this.#refreshing === shared) this.#refreshing = null; });
      this.#refreshing = shared;
    }
    return waitForCredential(this.#refreshing, signal);
  }
  public async logout(): Promise<void> {
    const current = this.#tokens;
    this.#tokens = null; this.#pending.clear(); this.#refreshing = null; ++this.#generation;
    await this.#writeStore(() => this.#store.clear());
    if (current === null) return;
    const form = new URLSearchParams({ client_id: CLIENT_ID, token: current.refreshToken });
    try {
      const response = await this.#fetch(new URL("/api/oauth/revoke", this.#platform), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
      });
      await response.body?.cancel().catch(() => undefined);
    } catch { /* Local logout succeeds even when the platform is unreachable. */ }
  }
}
