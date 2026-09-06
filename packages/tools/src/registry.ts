import type { JsonValue, ToolCapabilityCategory, ToolCapabilitySummary, ToolEvidence } from "@daoyin/harness-protocol";
import { assertExecutionIdentity, ExecutionAccessError, type ExecutionIdentity } from "@daoyin/harness-contracts";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonValue;
  category: ToolCapabilityCategory;
  mutating: boolean;
  /** Trusted registration only: allow intentional repeated writes within one turn. */
  repeatable?: boolean;
}

export interface ToolPack {
  id: string;
  tools: ToolDefinition[];
}

export interface ToolRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionContext {
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  sourceEventIds: string[];
  executionIdentity?: ExecutionIdentity;
  /** Filled by the registry, never taken from model-supplied arguments. */
  toolCallId?: string;
}

export interface ToolSuccess {
  ok: true;
  summary: string;
  evidence: ToolEvidence;
}

export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export type ToolExecution = ToolSuccess | ToolFailure;

export interface ToolDefinition extends ToolDescriptor {
  auditInput?(input: Record<string, unknown>): unknown;
  /** Return a bounded user-safe failure for expected outcomes; raw exceptions stay redacted. */
  execute(input: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<ToolExecution>;
}

/** Called without request during discovery, and WITH the exact request before execution. */
export type ToolAuthorization = (input: {
  tool: ToolDescriptor;
  context: ToolExecutionContext;
  request?: ToolRequest;
}) => boolean | Promise<boolean>;

export interface ToolRegistryOptions {
  /** Required whenever an executionIdentity is used; exceptions always deny access. */
  authorize?: ToolAuthorization;
}

function failure(code: string, message: string, retryable = false, details?: JsonValue): ToolFailure {
  return details === undefined ? { ok: false, code, message, retryable } : { ok: false, code, message, retryable, details };
}

function descriptor(tool: ToolDescriptor): ToolDescriptor {
  const { name, description, inputSchema, category, mutating } = tool;
  return { name, description, inputSchema, category, mutating, ...(tool.repeatable === undefined ? {} : { repeatable: tool.repeatable }) };
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #authorize: ToolAuthorization | undefined;

  public constructor(definitions: ToolDefinition[] = [], options: ToolRegistryOptions = {}) {
    this.#authorize = options.authorize;
    for (const definition of definitions) this.register(definition);
  }

  public register(definition: ToolDefinition): void {
    if (this.#tools.has(definition.name)) throw new Error(`Tool ${definition.name} is already registered.`);
    this.#tools.set(definition.name, definition);
  }

  public registerPack(pack: ToolPack): void {
    if (pack.id.trim().length === 0) throw new Error("Tool pack id cannot be empty.");
    for (const tool of pack.tools) this.register(tool);
  }

  /** Runtime configuration inventory, NOT a user-authorized capability endpoint. */
  public definitions(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Local/configuration inventory. AgentEngine uses descriptorsFor for model exposure. */
  public descriptors(): ToolDescriptor[] {
    return this.definitions().map(descriptor);
  }

  public capabilities(): ToolCapabilitySummary[] {
    return this.descriptors().map(({ name, description, category, mutating }) => ({ name, description, category, mutating }));
  }

  public async descriptorsFor(context: ToolExecutionContext): Promise<ToolDescriptor[]> {
    this.#assertContext(context);
    const result: ToolDescriptor[] = [];
    for (const tool of this.#tools.values()) {
      if (await this.#allowed(tool, context)) result.push(descriptor(tool));
    }
    return result;
  }

  public auditInput(toolName: string, input: Record<string, unknown>): unknown {
    const definition = this.#tools.get(toolName);
    // Cloud evidence never persists an untrusted arbitrary input body by default.
    if (definition?.auditInput === undefined) {
      return this.#authorize === undefined ? input : { keys: Object.keys(input).slice(0, 64) };
    }
    try {
      return definition.auditInput(input);
    } catch {
      return { redacted: true };
    }
  }

  public async execute(
    request: ToolRequest,
    signal: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolExecution> {
    if (signal.aborted) return failure("TOOL_CANCELLED", "Tool execution was cancelled.");
    try {
      this.#assertContext(context);
    } catch (error) {
      return failure(
        error instanceof ExecutionAccessError ? error.code : "TOOL_CONTEXT_REQUIRED",
        "工具缺少有效的执行身份或授权。",
      );
    }
    const definition = this.#tools.get(request.name);
    if (definition === undefined) return failure("TOOL_NOT_FOUND", `Tool ${request.name} is not available.`);
    if (!await this.#allowed(definition, context, request)) {
      return failure("TOOL_ACCESS_DENIED", "当前身份无权执行此操作。请检查空间、应用权限和授权。");
    }
    // The policy may have awaited a remote check; observe cancellation again before any I/O.
    if (signal.aborted) return failure("TOOL_CANCELLED", "Tool execution was cancelled.");
    try {
      return await definition.execute(request.input, signal, { ...context, toolCallId: request.id });
    } catch (error) {
      // Remote business adapters must return safe evidence, not raw credentials or server errors.
      if (this.#authorize !== undefined) return failure("TOOL_EXECUTION_FAILED", "业务工具执行失败，请查看受控审计记录。");
      const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
      const details = candidate.details === undefined ? undefined : candidate.details as JsonValue;
      return failure(
        typeof candidate.code === "string" ? candidate.code : "TOOL_EXECUTION_FAILED",
        typeof candidate.message === "string" ? candidate.message : "Tool execution failed.",
        candidate.retryable === true,
        details,
      );
    }
  }

  #assertContext(context: ToolExecutionContext | undefined): asserts context is ToolExecutionContext {
    if (context === undefined || !context.accountId || !context.scopeId || !context.sessionId || !context.turnId) {
      throw new ExecutionAccessError("TOOL_CONTEXT_REQUIRED", "工具必须显式传入执行上下文。");
    }
    if (this.#authorize !== undefined || context.executionIdentity !== undefined) {
      assertExecutionIdentity(context.executionIdentity);
      if (context.executionIdentity.actorUserId !== context.accountId || this.#authorize === undefined) {
        throw new ExecutionAccessError("TOOL_AUTHORIZATION_REQUIRED", "云端身份必须使用授权工具注册表。");
      }
    }
  }

  async #allowed(tool: ToolDescriptor, context: ToolExecutionContext, request?: ToolRequest): Promise<boolean> {
    if (this.#authorize === undefined) return true;
    try {
      this.#assertContext(context);
      const allowed = await this.#authorize({
        tool: descriptor(tool), context, ...(request === undefined ? {} : { request }),
      });
      // An awaited authorization response must not outlive its grant.
      this.#assertContext(context);
      return allowed === true;
    } catch {
      return false;
    }
  }
}
