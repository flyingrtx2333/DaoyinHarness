import { wireMessages, type ModelClient, type ModelReply, type ModelRequest, type ModelToolCall } from "@daoyin/harness-agent-core";

const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARACTERS = 100_000;

export interface CloudCredentialProvider {
  getCredential(signal: AbortSignal): Promise<string>;
}

export interface DaoyinGatewayModelClientOptions {
  endpoint: string;
  credentialProvider: CloudCredentialProvider;
  model?: string;
  clientVersion?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ModelGatewayError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly status: number | null;
  public readonly requestId: string | null;

  public constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number | null; requestId?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelGatewayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
  }
}

function normalizeCredential(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export class InMemoryCloudCredentialProvider implements CloudCredentialProvider {
  #credential: string | null;

  public constructor(credential: string | null = null) {
    this.#credential = normalizeCredential(credential);
  }

  public setCredential(credential: string): void {
    this.#credential = normalizeCredential(credential);
  }

  public clear(): void {
    this.#credential = null;
  }

  public async getCredential(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException("The model request was aborted.", "AbortError");
    if (this.#credential === null) {
      throw new ModelGatewayError("MODEL_AUTH_REQUIRED", "道引模型网关需要登录。", { retryable: false });
    }
    return this.#credential;
  }
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ModelGatewayError("MODEL_GATEWAY_CONFIG_INVALID", "模型网关 URL 无效。", { cause: error });
  }
  if (url.username || url.password) {
    throw new ModelGatewayError("MODEL_GATEWAY_CONFIG_INVALID", "模型网关 URL 不能包含凭据。", { retryable: false });
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ModelGatewayError("MODEL_GATEWAY_CONFIG_INVALID", "模型网关必须使用 HTTPS；仅回环开发网关可使用 HTTP。", { retryable: false });
  }
  url.hash = "";
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const requestId = value.requestId ?? value.request_id;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId.trim().slice(0, 200) : null;
}

function publicError(value: unknown): { code?: string; message?: string } {
  if (!isRecord(value)) return {};
  const candidate = isRecord(value.error) ? value.error : value;
  const code = typeof candidate.code === "string" ? candidate.code.trim().slice(0, 120) : undefined;
  const message = typeof candidate.message === "string" ? candidate.message.trim().slice(0, 1_000) : undefined;
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function statusError(status: number, payload: unknown, requestId: string | null): ModelGatewayError {
  const gateway = publicError(payload);
  if (status === 422) {
    // Validation responses may echo credentials or document contents in `input`.
    // Inspect only the known error type/location; never surface raw details.
    const oversized = isRecord(payload) && Array.isArray(payload.detail) && payload.detail.some((detail: unknown) =>
      isRecord(detail) && detail.type === "string_too_long" && Array.isArray(detail.loc)
      && detail.loc.length === 4 && detail.loc[0] === "body" && detail.loc[1] === "messages"
      && typeof detail.loc[2] === "number" && detail.loc[3] === "content",
    );
    return new ModelGatewayError(oversized ? "MODEL_CONTEXT_TOO_LARGE" : "MODEL_GATEWAY_VALIDATION", oversized
      ? "模型请求中的内容超过网关长度限制，请缩小读取范围后重试（HTTP 422）。"
      : "模型请求格式校验失败（HTTP 422），请检查模型网关协议兼容性。", { status, requestId });
  }
  if (status === 401) {
    return new ModelGatewayError("MODEL_AUTH_REQUIRED", gateway.message ?? "道引模型网关登录已失效。", { status, requestId });
  }
  if (status === 402 || status === 403) {
    return new ModelGatewayError(
      gateway.code === "quota_exhausted" ? "MODEL_QUOTA_EXHAUSTED" : "MODEL_ACCESS_DENIED",
      gateway.message ?? "当前账号没有可用的模型权限或额度。",
      { status, requestId },
    );
  }
  if (status === 408 || status === 429) {
    return new ModelGatewayError(
      status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_GATEWAY_TIMEOUT",
      gateway.message ?? "模型网关暂时繁忙，请稍后重试。",
      { retryable: true, status, requestId },
    );
  }
  if (status >= 500) {
    return new ModelGatewayError("MODEL_GATEWAY_UNAVAILABLE", gateway.message ?? "模型网关暂时不可用。", {
      retryable: true,
      status,
      requestId,
    });
  }
  return new ModelGatewayError(gateway.code || "MODEL_GATEWAY_REJECTED", gateway.message ?? `模型网关拒绝了请求（HTTP ${String(status)}）。`, {
    retryable: false,
    status,
    requestId,
  });
}

function parseToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) {
    throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关返回了无效的工具调用。", { retryable: true });
  }
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string" || value.name.length === 0 || !isRecord(value.input)) {
    throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关返回了无效的工具调用字段。", { retryable: true });
  }
  return { id: value.id, name: value.name, input: value.input };
}

function parseReply(payload: unknown): ModelReply {
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.output)) {
    throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关响应不符合 DaoyinHarness v1 协议。", { retryable: true });
  }
  const output = payload.output;
  if (output.kind === "assistant") {
    if (typeof output.content !== "string") {
      throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关 assistant 响应缺少文本。", { retryable: true });
    }
    return { kind: "assistant", content: output.content };
  }
  if (output.kind === "tool_calls") {
    if (!Array.isArray(output.calls)) {
      throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关 tool_calls 响应缺少 calls。", { retryable: true });
    }
    return {
      kind: "tool_calls",
      calls: output.calls.map(parseToolCall),
      ...(typeof output.content === "string" ? { content: output.content } : {}),
    };
  }
  throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关返回了未知输出类型。", { retryable: true });
}

async function parsePayload(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ModelGatewayError("MODEL_GATEWAY_RESPONSE_TOO_LARGE", "模型网关响应超过本地允许大小。", { retryable: true, status: response.status });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ModelGatewayError("MODEL_GATEWAY_RESPONSE_TOO_LARGE", "模型网关响应超过本地允许大小。", { retryable: true, status: response.status });
  }
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ModelGatewayError("MODEL_GATEWAY_PROTOCOL", "模型网关返回了无法解析的 JSON。", { retryable: true, status: response.status, cause: error });
  }
}

function requestBody(request: ModelRequest, model: string | undefined): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(model === undefined ? {} : { model }),
    messages: wireMessages(request),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    systemPrompt: {
      stableText: request.systemPrompt.stableText,
      dynamicText: request.systemPrompt.dynamicText,
      sections: request.systemPrompt.sections,
    },
  };
}

export class DaoyinGatewayModelClient implements ModelClient {
  readonly #endpoint: URL;
  readonly #credentialProvider: CloudCredentialProvider;
  readonly #model: string | undefined;
  readonly #clientVersion: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  public constructor(options: DaoyinGatewayModelClientOptions) {
    this.#endpoint = parseEndpoint(options.endpoint);
    this.#credentialProvider = options.credentialProvider;
    this.#model = options.model?.trim() || undefined;
    this.#clientVersion = options.clientVersion?.trim() || undefined;
    this.#timeoutMs = Math.max(1_000, Math.min(300_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.#fetch = options.fetch ?? fetch;
  }

  public async complete(request: ModelRequest): Promise<ModelReply> {
    const oversizedIndex = request.messages.findIndex((message) => message.content.length > MAX_MESSAGE_CHARACTERS);
    if (oversizedIndex !== -1) {
      throw new ModelGatewayError("MODEL_CONTEXT_TOO_LARGE", `第 ${String(oversizedIndex + 1)} 条模型消息超过 ${String(MAX_MESSAGE_CHARACTERS)} 字符限制，请缩小读取范围或精简上下文后重试。`);
    }
    const credential = await this.#credentialProvider.getCredential(request.signal);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + credential,
          "content-type": "application/json",
          accept: "application/json",
          ...(this.#clientVersion === undefined ? {} : { "x-daoyin-harness-version": this.#clientVersion }),
        },
        body: JSON.stringify(requestBody(request, this.#model)),
        signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (timeout.aborted) {
        throw new ModelGatewayError("MODEL_GATEWAY_TIMEOUT", "模型网关请求超时。", { retryable: true, cause: error });
      }
      throw new ModelGatewayError("MODEL_GATEWAY_NETWORK", "无法连接道引模型网关。", { retryable: true, cause: error });
    }

    const payload = await parsePayload(response);
    const requestId = response.headers.get("x-request-id")?.trim() || requestIdFrom(payload);
    if (!response.ok) throw statusError(response.status, payload, requestId || null);
    try {
      return parseReply(payload);
    } catch (error) {
      if (error instanceof ModelGatewayError && error.requestId === null && requestId) {
        throw new ModelGatewayError(error.code, error.message, {
          retryable: error.retryable,
          status: error.status ?? response.status,
          requestId,
          cause: error,
        });
      }
      throw error;
    }
  }
}

export function createDevelopmentGatewayModelFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  clientVersion?: string,
): DaoyinGatewayModelClient | null {
  const endpoint = environment.DAOYIN_HARNESS_GATEWAY_URL?.trim() ?? "";
  const credential = environment.DAOYIN_HARNESS_GATEWAY_CREDENTIAL?.trim() ?? "";
  const model = environment.DAOYIN_HARNESS_MODEL?.trim() ?? "";
  if (!endpoint && !credential && !model) return null;
  if (!endpoint || !credential) {
    throw new ModelGatewayError(
      "MODEL_GATEWAY_CONFIG_INVALID",
      "开发期模型网关需要同时设置 DAOYIN_HARNESS_GATEWAY_URL 和 DAOYIN_HARNESS_GATEWAY_CREDENTIAL。",
    );
  }
  return new DaoyinGatewayModelClient({
    endpoint,
    credentialProvider: new InMemoryCloudCredentialProvider(credential),
    ...(model ? { model } : {}),
    ...(clientVersion ? { clientVersion } : {}),
  });
}
