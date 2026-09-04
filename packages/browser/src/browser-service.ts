import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PublicNetworkPolicy } from "./network-policy.js";
import { PublicBrowserProxy } from "./public-proxy.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TEXT_CHARACTERS = 30_000;
const DEFAULT_MAX_ELEMENTS = 120;
const MAX_SESSIONS = 8;
const REF_ATTRIBUTE = "data-daoyin-harness-ref";
const SAFE_REF = /^e[1-9][0-9]{0,3}$/u;

export interface BrowserRuntimeStatus {
  available: boolean;
  executablePath: string | null;
  reason: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  text: string;
  name: string;
  type: string;
  href: string;
  disabled: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
}

export interface BrowserServiceOptions {
  executablePath?: string;
  headless?: boolean;
  timeoutMs?: number;
  navigationTimeoutMs?: number;
  maxTextCharacters?: number;
  maxElements?: number;
  networkPolicy?: PublicNetworkPolicy;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = path.resolve(value);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function browserExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const explicit = environment.DAOYIN_HARNESS_BROWSER_EXECUTABLE;
  if (platform === "win32") {
    return unique([
      explicit,
      environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
      environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  if (platform === "darwin") {
    return unique([
      explicit,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
  }
  return unique([
    explicit,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
  ]);
}

export async function discoverBrowserExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through fixed candidates only.
    }
  }
  return null;
}

function browserError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function normalizedRef(ref: string): string {
  const value = ref.trim();
  if (!SAFE_REF.test(value)) throw browserError("BROWSER_REF_INVALID", "Browser element ref is invalid.");
  return value;
}

function boundedText(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

export class BrowserService {
  readonly #status: BrowserRuntimeStatus;
  readonly #headless: boolean;
  readonly #timeoutMs: number;
  readonly #navigationTimeoutMs: number;
  readonly #maxTextCharacters: number;
  readonly #maxElements: number;
  readonly #networkPolicy: PublicNetworkPolicy;
  readonly #sessions = new Map<string, BrowserSession>();
  #browser: Browser | null = null;
  #proxy: PublicBrowserProxy | null = null;
  #launching: Promise<Browser> | null = null;

  private constructor(status: BrowserRuntimeStatus, options: BrowserServiceOptions) {
    this.#status = status;
    this.#headless = options.headless ?? true;
    this.#timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.#navigationTimeoutMs = Math.max(2_000, Math.min(120_000, options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS));
    this.#maxTextCharacters = Math.max(1_000, Math.min(100_000, options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS));
    this.#maxElements = Math.max(10, Math.min(300, options.maxElements ?? DEFAULT_MAX_ELEMENTS));
    this.#networkPolicy = options.networkPolicy ?? new PublicNetworkPolicy();
  }

  public static async create(options: BrowserServiceOptions = {}): Promise<BrowserService> {
    const candidates = options.executablePath === undefined
      ? browserExecutableCandidates(options.environment, options.platform)
      : [path.resolve(options.executablePath)];
    const executablePath = await discoverBrowserExecutable(candidates);
    const status: BrowserRuntimeStatus = executablePath === null
      ? {
          available: false,
          executablePath: null,
          reason: "No supported local Chrome, Edge, or Chromium executable was discovered.",
        }
      : {
          available: true,
          executablePath,
          reason: `Browser executable discovered at ${executablePath}.`,
        };
    return new BrowserService(status, options);
  }

  public get status(): BrowserRuntimeStatus {
    return { ...this.#status };
  }

  public async open(sessionId: string, rawUrl: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const target = await this.#networkPolicy.validateNavigationUrl(rawUrl);
    const session = await this.#session(sessionId);
    return this.#withAbort(sessionId, signal, async () => {
      await session.page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: this.#navigationTimeoutMs });
      session.lastUsedAt = Date.now();
      return this.#snapshotPage(session.page);
    });
  }

  public async snapshot(sessionId: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const session = await this.#existingSession(sessionId);
    return this.#withAbort(sessionId, signal, async () => {
      session.lastUsedAt = Date.now();
      return this.#snapshotPage(session.page);
    });
  }

  public async click(sessionId: string, ref: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const session = await this.#existingSession(sessionId);
    const safeRef = normalizedRef(ref);
    return this.#withAbort(sessionId, signal, async () => {
      const locator = session.page.locator(`[${REF_ATTRIBUTE}="${safeRef}"]`);
      if (await locator.count() !== 1) throw browserError("BROWSER_REF_STALE", "Browser element ref is stale; take a new snapshot.");
      await locator.click({ timeout: this.#timeoutMs });
      await session.page.waitForTimeout(150);
      session.lastUsedAt = Date.now();
      return this.#snapshotPage(session.page);
    });
  }

  public async type(sessionId: string, ref: string, text: string, submit: boolean, signal: AbortSignal): Promise<BrowserSnapshot> {
    if (text.length > 8_000) throw browserError("BROWSER_INPUT_TOO_LARGE", "Browser text input exceeds 8000 characters.");
    const session = await this.#existingSession(sessionId);
    const safeRef = normalizedRef(ref);
    return this.#withAbort(sessionId, signal, async () => {
      const locator = session.page.locator(`[${REF_ATTRIBUTE}="${safeRef}"]`);
      if (await locator.count() !== 1) throw browserError("BROWSER_REF_STALE", "Browser element ref is stale; take a new snapshot.");
      const metadata = await locator.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
        autocomplete: element.getAttribute("autocomplete")?.toLowerCase() ?? "",
        editable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true",
      }));
      if (metadata.type === "password" || metadata.autocomplete.includes("password")) {
        throw browserError("BROWSER_SECRET_INPUT_DENIED", "Password/secret fields are not accepted by browser_type because tool inputs are auditable.");
      }
      if (!metadata.editable) throw browserError("BROWSER_ELEMENT_NOT_EDITABLE", `Element ${safeRef} is not an editable input.`);
      await locator.fill(text, { timeout: this.#timeoutMs });
      if (submit) await locator.press("Enter", { timeout: this.#timeoutMs });
      await session.page.waitForTimeout(150);
      session.lastUsedAt = Date.now();
      return this.#snapshotPage(session.page);
    });
  }

  public async back(sessionId: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const session = await this.#existingSession(sessionId);
    return this.#withAbort(sessionId, signal, async () => {
      await session.page.goBack({ waitUntil: "domcontentloaded", timeout: this.#navigationTimeoutMs });
      session.lastUsedAt = Date.now();
      return this.#snapshotPage(session.page);
    });
  }

  public async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
  }

  public async close(): Promise<void> {
    const sessions = [...this.#sessions.keys()];
    await Promise.all(sessions.map(async (sessionId) => this.closeSession(sessionId)));
    const browser = this.#browser;
    this.#browser = null;
    this.#launching = null;
    if (browser !== null) await browser.close().catch(() => undefined);
    const proxy = this.#proxy;
    this.#proxy = null;
    if (proxy !== null) await proxy.close();
  }

  async #browserInstance(): Promise<Browser> {
    if (!this.#status.available || this.#status.executablePath === null) {
      throw browserError("BROWSER_UNAVAILABLE", this.#status.reason);
    }
    const executablePath = this.#status.executablePath;
    if (this.#browser !== null && this.#browser.isConnected()) return this.#browser;
    if (this.#launching !== null) return this.#launching;
    this.#launching = (async () => {
      const proxy = this.#proxy ?? new PublicBrowserProxy({ policy: this.#networkPolicy });
      this.#proxy = proxy;
      const proxyUrl = await proxy.start();
      try {
        const browser = await chromium.launch({
          executablePath,
          headless: this.#headless,
          proxy: { server: proxyUrl, bypass: "<-loopback>" },
          args: [
            "--proxy-bypass-list=<-loopback>",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--no-default-browser-check",
            "--no-first-run",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ],
        });
        browser.once("disconnected", () => {
          if (this.#browser === browser) this.#browser = null;
          this.#sessions.clear();
        });
        this.#browser = browser;
        return browser;
      } catch (error) {
        await proxy.close().catch(() => undefined);
        this.#proxy = null;
        throw Object.assign(browserError("BROWSER_LAUNCH_FAILED", error instanceof Error ? error.message : "Browser launch failed.", true), { cause: error });
      } finally {
        this.#launching = null;
      }
    })();
    return this.#launching;
  }

  async #session(sessionId: string): Promise<BrowserSession> {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest !== undefined) await this.closeSession(oldest[0]);
    }
    const browser = await this.#browserInstance();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      ignoreHTTPSErrors: false,
      viewport: { width: 1440, height: 1000 },
      userAgent: "DaoyinHarness/0.1 Browser",
    });
    context.setDefaultTimeout(this.#timeoutMs);
    context.setDefaultNavigationTimeout(this.#navigationTimeoutMs);
    await context.addInitScript(() => {
      try {
        Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: false, value: undefined });
        Object.defineProperty(globalThis, "webkitRTCPeerConnection", { configurable: false, value: undefined });
      } catch {
        // Browser launch policy remains the primary network boundary.
      }
    });
    const page = await context.newPage();
    page.on("popup", (popup) => {
      void popup.close().catch(() => undefined);
    });
    const session = { context, page, lastUsedAt: Date.now() };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #existingSession(sessionId: string): Promise<BrowserSession> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.page.isClosed()) {
      throw browserError("BROWSER_SESSION_NOT_OPEN", "No browser page is open for this session. Use browser_open first.");
    }
    return session;
  }

  async #withAbort<T>(sessionId: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw browserError("TOOL_CANCELLED", "Browser operation was cancelled.");
    let abortListener: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        void this.closeSession(sessionId);
        reject(browserError("TOOL_CANCELLED", "Browser operation was cancelled."));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (signal.aborted) throw browserError("TOOL_CANCELLED", "Browser operation was cancelled.");
      if (typeof error === "object" && error !== null && "code" in error) throw error;
      throw Object.assign(browserError("BROWSER_OPERATION_FAILED", error instanceof Error ? error.message : "Browser operation failed.", true), { cause: error });
    } finally {
      if (abortListener !== null) signal.removeEventListener("abort", abortListener);
    }
  }

  async #snapshotPage(page: Page): Promise<BrowserSnapshot> {
    const currentUrl = page.url();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw browserError("BROWSER_PAGE_INVALID", "Browser page URL is invalid and cannot be exposed as evidence.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw browserError("BROWSER_PAGE_SCHEME_DENIED", "Browser navigated to a non-HTTP(S) page and will not expose it as successful evidence.");
    }
    const title = await page.title().catch(() => "");
    const snapshot = await page.evaluate(({ refAttribute, maxTextCharacters, maxElements }) => {
      for (const element of document.querySelectorAll(`[${refAttribute}]`)) element.removeAttribute(refAttribute);
      const text = (document.body?.innerText ?? "").slice(0, maxTextCharacters);
      const selector = "a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']";
      const elements: BrowserSnapshotElement[] = [];
      const candidates = [...document.querySelectorAll<HTMLElement>(selector)];
      for (const element of candidates) {
        if (elements.length >= maxElements) break;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) continue;
        const ref = `e${String(elements.length + 1)}`;
        element.setAttribute(refAttribute, ref);
        const input = element instanceof HTMLInputElement ? element : null;
        const anchor = element instanceof HTMLAnchorElement ? element : null;
        elements.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") ?? "",
          text: (element.innerText || element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 300),
          name: (element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("placeholder") || element.getAttribute("title") || "").slice(0, 300),
          type: input?.type ?? "",
          href: anchor?.href ?? "",
          disabled: "disabled" in element && Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
        });
      }
      return { text, elements };
    }, {
      refAttribute: REF_ATTRIBUTE,
      maxTextCharacters: this.#maxTextCharacters,
      maxElements: this.#maxElements,
    });
    return {
      url: page.url(),
      title: boundedText(title, 500),
      text: boundedText(snapshot.text, this.#maxTextCharacters),
      elements: snapshot.elements,
    };
  }
}
