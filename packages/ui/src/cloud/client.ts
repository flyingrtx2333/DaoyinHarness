import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun, CloudSession } from "../../../server-cloud/src/repository.js";

export type { CloudRun, CloudSession };
export interface PendingRequest { sessionId: string; requestId: string; message: string }
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const RECEIPTS = "daoyin-harness-cloud-receipts-v1";
const BASE = "/api/company-assistant/agent";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);

export class WorkbenchError extends Error {
  public constructor(message: string, public readonly status = 0, public readonly loginUrl?: string) { super(message); }
}

/** First-party applications inherit the signed-in account through their same-origin BFF. */
export class WorkbenchClient {
  #csrf = "";
  #accountScope = "";
  readonly #base: string;
  #receiptKey: string;
  readonly #receipts = new Map<string, PendingRequest>();
  public get accountScope(): string { return this.#accountScope; }
  public constructor(private readonly storage: StoragePort, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), public readonly application: "company" | "saishi" = "company") {
    this.#base = application === "saishi" ? "/api/agent-apps/saishi/workbench" : BASE;
    this.#receiptKey = application === "saishi" ? `${RECEIPTS}:saishi` : RECEIPTS;
    if (application === "company") this.#restoreReceipts();
  }

  #restoreReceipts(): void {
    this.#receipts.clear();
    try {
      const data: unknown = JSON.parse(this.storage.getItem(this.#receiptKey) ?? "[]");
      if (Array.isArray(data)) for (const item of data) {
        if (typeof item === "object" && item !== null && identifier(item.sessionId) && identifier(item.requestId) &&
            typeof item.message === "string" && item.message.length > 0 && item.message.length <= 10000) {
          this.#receipts.set(item.sessionId, { sessionId: item.sessionId, requestId: item.requestId, message: item.message });
        }
      }
    } catch { /* Invalid/unavailable storage is checked again before every billable submission. */ }
  }

  async #request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await this.fetcher(this.#base + path, {
        method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", ...(this.#accountScope && path !== "/bootstrap" ? { "x-agent-account": this.#accountScope } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", "x-agent-csrf": this.#csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || (this.application === "saishi" && response.status === 403)) {
          this.#csrf = "";
          this.#accountScope = "";
          if (this.application === "saishi") {
            this.#receipts.clear();
            let loginUrl: string | undefined;
            if (response.status === 401) {
              const detail: unknown = await response.json().catch(() => null);
              if (typeof detail === "object" && detail !== null && "loginUrl" in detail && typeof detail.loginUrl === "string" &&
                  /^\/api\/agent-apps\/saishi\/workbench\/login(?:\?[A-Za-z0-9%=&_.-]*)?$/u.test(detail.loginUrl)) loginUrl = detail.loginUrl;
            }
            throw new WorkbenchError(response.status === 401 ? "请登录道引账号，登录后即可使用该账号的赛事数据。" : "当前账号没有此赛事数据的访问权限。", response.status, loginUrl);
          }
          throw new WorkbenchError("访客授权已过期，请重新进入工作台。", response.status);
        }
        if (response.status === 429) throw new WorkbenchError("当前使用次数已达上限，请稍后重试。", 429);
        if (response.status === 409) throw new WorkbenchError("原任务仍在处理中，或原请求内容已改变。请刷新查看原任务。", 409);
        throw new WorkbenchError("请求未完成。请重新连接；提交结果不确定时可恢复原提交。", response.status);
      }
      return await response.json() as T;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("View closed", "AbortError");
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("连接中断，请重新连接。已提交的任务会保留，可以恢复原提交。");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  public async disconnectApplication(): Promise<void> {
    await this.#request("/logout", {});
    this.#csrf = "";
    this.#accountScope = "";
    this.#receipts.clear();
    this.storage.removeItem(this.#receiptKey);
  }
  public async bootstrap(): Promise<number> {
    const result = await this.#request<{ csrfToken: string; expiresAt: number; profileId?: string; authentication?: string; accountScope?: string }>("/bootstrap", {});
    if (!result.csrfToken || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() ||
        (this.application === "saishi" && (result.profileId !== "saishi-readonly" || result.authentication !== "account" || !identifier(result.accountScope)))) {
      this.#csrf = ""; this.#accountScope = ""; this.#receipts.clear();
      throw new WorkbenchError("账号工作台尚未接通，请稍后重新连接。");
    }
    if (this.application === "saishi") {
      this.#accountScope = result.accountScope!;
      this.#receiptKey = `${RECEIPTS}:saishi:${this.#accountScope}`;
      this.#restoreReceipts();
    }
    this.#csrf = result.csrfToken;
    return result.expiresAt;
  }
  public async sessions(signal?: AbortSignal): Promise<CloudSession[]> {
    return (await this.#request<{ sessions: CloudSession[] }>("/sessions", undefined, signal)).sessions;
  }
  public async createSession(title: string, expectedProfileId = "company-public"): Promise<CloudSession> {
    if (/saishi_agent_[A-Za-z0-9_-]{64}/u.test(title)) throw new WorkbenchError("检测到访问凭证，请勿发送到聊天。业务数据使用当前登录账号访问。");
    const session = (await this.#request<{ session: CloudSession }>("/sessions", { title: title.slice(0, 80) })).session;
    if (session.profileId !== expectedProfileId) throw new WorkbenchError("服务端返回的插件与选择不一致，请重新连接后查看会话。");
    return session;
  }
  public async runs(sessionId: string, signal?: AbortSignal): Promise<CloudRun[]> {
    const runs = (await this.#request<{ runs: CloudRun[] }>(`/sessions/${encodeURIComponent(sessionId)}/runs`, undefined, signal)).runs;
    const pending = this.pending(sessionId);
    if (pending && runs.some((run) => run.requestId === pending.requestId && run.userMessage === pending.message)) this.#forget(sessionId);
    return runs;
  }
  public async events(sessionId: string, after: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    let cursor = after;
    for (let page = 0; page < 100; page++) {
      const result = await this.#request<{ events: AgentEvent[]; hasMore: boolean; nextEventSeq: number }>(
        `/sessions/${encodeURIComponent(sessionId)}/events?after=${String(cursor)}`, undefined, signal);
      for (const event of result.events) if (event.eventSeq > cursor) { events.push(event); cursor = event.eventSeq; }
      if (!result.hasMore) return events;
      if (result.nextEventSeq <= after || result.nextEventSeq !== cursor) throw new WorkbenchError("会话回放游标无效，请重新连接。");
      after = cursor;
    }
    throw new WorkbenchError("会话记录较多，请新建会话后继续。");
  }
  public pending(sessionId: string): PendingRequest | undefined { return this.#receipts.get(sessionId); }
  #persist(): void {
    try { this.storage.setItem(this.#receiptKey, JSON.stringify([...this.#receipts.values()])); }
    catch { throw new WorkbenchError("浏览器无法保存请求回执。请允许本站会话存储后再提交。"); }
  }
  #forget(sessionId: string): void {
    this.#receipts.delete(sessionId);
    try { this.#persist(); } catch { /* A stale durable receipt still reuses the same accepted request. */ }
  }
  public async submit(sessionId: string, message: string): Promise<CloudRun> {
    if (this.application === "saishi" && !this.#accountScope) throw new WorkbenchError("请先连接当前道引账号。", 401);
    if (/saishi_agent_[A-Za-z0-9_-]{64}/u.test(message)) throw new WorkbenchError("检测到访问凭证，请勿发送到聊天。业务数据使用当前登录账号访问。");
    const existing = this.pending(sessionId);
    if (existing && existing.message !== message) throw new WorkbenchError("上次提交结果尚未确认，请先恢复原提交。");
    const receipt = existing ?? { sessionId, requestId: crypto.randomUUID(), message };
    this.#receipts.set(sessionId, receipt);
    this.#persist(); // Must succeed before a model run can be admitted.
    const result = await this.#request<{ run: CloudRun }>(`/sessions/${encodeURIComponent(sessionId)}/runs`,
      { requestId: receipt.requestId, message: receipt.message });
    this.#forget(sessionId);
    return result.run;
  }
  public async cancel(runId: string): Promise<void> { await this.#request(`/runs/${encodeURIComponent(runId)}/cancel`, {}); }
}
