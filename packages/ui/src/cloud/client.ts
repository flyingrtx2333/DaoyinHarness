import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun, CloudSession } from "../../../server-cloud/src/repository.js";

export type { CloudRun, CloudSession };
export interface PendingRequest { sessionId: string; requestId: string; message: string }
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const RECEIPTS = "daoyin-harness-cloud-receipts-v1";
const BASE = "/api/company-assistant/agent";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);

export class WorkbenchError extends Error {
  public constructor(message: string, public readonly status = 0) { super(message); }
}

/** Fixed same-origin BFFs. Application tokens enter only through connectApplication,
 * never through model messages, local storage or arbitrary service URLs. */
export class WorkbenchClient {
  #csrf = "";
  readonly #base: string;
  readonly #receiptKey: string;
  readonly #receipts = new Map<string, PendingRequest>();
  public constructor(private readonly storage: StoragePort, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), public readonly application: "company" | "saishi" = "company") {
    this.#base = application === "saishi" ? "/api/agent-apps/saishi/workbench" : BASE;
    this.#receiptKey = application === "saishi" ? `${RECEIPTS}:saishi` : RECEIPTS;
    try {
      const data: unknown = JSON.parse(storage.getItem(this.#receiptKey) ?? "[]");
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
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "x-agent-csrf": this.#csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || (this.application === "saishi" && response.status === 403)) {
          this.#csrf = "";
          throw new WorkbenchError(this.application === "saishi" ? "赛事授权已失效或范围不足，请重新连接。" : "访客授权已过期，请重新进入工作台。", response.status);
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

  public async connectApplication(token: string): Promise<void> {
    if (this.application !== "saishi" || !/^saishi_agent_[A-Za-z0-9_-]{64}$/u.test(token)) throw new WorkbenchError("请输入赛事后台签发的只读授权。");
    await this.#request("/connect", { token });
    this.#csrf = "";
    this.#receipts.clear();
    this.storage.removeItem(this.#receiptKey);
  }
  public async disconnectApplication(): Promise<void> {
    await this.#request("/logout", {});
    this.#csrf = "";
    this.#receipts.clear();
    this.storage.removeItem(this.#receiptKey);
  }
  public async bootstrap(): Promise<number> {
    const result = await this.#request<{ csrfToken: string; expiresAt: number; profileId?: string }>("/bootstrap", {});
    if (!result.csrfToken || !Number.isFinite(result.expiresAt) || (this.application === "saishi" && result.profileId !== "saishi-readonly")) throw new WorkbenchError("工作台授权响应无效，请重新进入。");
    this.#csrf = result.csrfToken;
    return result.expiresAt;
  }
  public async sessions(signal?: AbortSignal): Promise<CloudSession[]> {
    return (await this.#request<{ sessions: CloudSession[] }>("/sessions", undefined, signal)).sessions;
  }
  public async createSession(title: string, expectedProfileId = "company-public"): Promise<CloudSession> {
    if (/saishi_agent_[A-Za-z0-9_-]{64}/u.test(title)) throw new WorkbenchError("检测到赛事授权凭证，请使用专用授权表单，不要发送到聊天。");
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
    if (/saishi_agent_[A-Za-z0-9_-]{64}/u.test(message)) throw new WorkbenchError("检测到赛事授权凭证，请使用专用授权表单，不要发送到聊天。");
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
