import type { JsonValue, ToolCapabilityCategory, ToolCapabilitySummary, ToolEvidence } from "@daoyin/harness-protocol";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonValue;
  category: ToolCapabilityCategory;
  mutating: boolean;
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
  execute(input: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<ToolSuccess>;
}

function failure(code: string, message: string, retryable = false, details?: JsonValue): ToolFailure {
  return details === undefined ? { ok: false, code, message, retryable } : { ok: false, code, message, retryable, details };
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  public constructor(definitions: ToolDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  public register(definition: ToolDefinition): void {
    if (this.#tools.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered.`);
    }
    this.#tools.set(definition.name, definition);
  }

  public registerPack(pack: ToolPack): void {
    if (pack.id.trim().length === 0) throw new Error("Tool pack id cannot be empty.");
    for (const tool of pack.tools) this.register(tool);
  }

  public definitions(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  public descriptors(): ToolDescriptor[] {
    return this.definitions().map(({ name, description, inputSchema, category, mutating }) => ({
      name,
      description,
      inputSchema,
      category,
      mutating,
    }));
  }

  public capabilities(): ToolCapabilitySummary[] {
    return this.descriptors().map(({ name, description, category, mutating }) => ({ name, description, category, mutating }));
  }

  public auditInput(toolName: string, input: Record<string, unknown>): unknown {
    const definition = this.#tools.get(toolName);
    if (definition?.auditInput === undefined) return input;
    try {
      return definition.auditInput(input);
    } catch {
      return { redacted: true };
    }
  }

  public async execute(
    request: ToolRequest,
    signal: AbortSignal,
    context: ToolExecutionContext = {
      accountId: "local_test",
      scopeId: "scope_test",
      sessionId: "session_test",
      turnId: "turn_test",
      sourceEventIds: [],
    },
  ): Promise<ToolExecution> {
    if (signal.aborted) {
      return failure("TOOL_CANCELLED", "Tool execution was cancelled.");
    }
    const definition = this.#tools.get(request.name);
    if (definition === undefined) {
      return failure("TOOL_NOT_FOUND", `Tool ${request.name} is not available.`);
    }
    try {
      return await definition.execute(request.input, signal, context);
    } catch (error) {
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
}
